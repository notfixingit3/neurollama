//go:build linux

package main

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

func collectGPUs() []GPUInfo {
	var gpus []GPUInfo

	// NVIDIA — most accurate via nvidia-smi
	gpus = append(gpus, nvidiaGPUs()...)

	// AMD and Intel — via sysfs (handles both amdgpu and xe/i915 drivers)
	// Skips any PCI slots already claimed by NVIDIA
	gpus = append(gpus, sysfsGPUs()...)

	return gpus
}

// nvidiaGPUs queries nvidia-smi for per-card VRAM stats.
func nvidiaGPUs() []GPUInfo {
	out, err := exec.Command("nvidia-smi",
		"--query-gpu=index,name,memory.total,memory.used,memory.free",
		"--format=csv,noheader,nounits").Output()
	if err != nil {
		return nil
	}

	var gpus []GPUInfo
	scanner := bufio.NewScanner(bytes.NewReader(out))
	for scanner.Scan() {
		parts := strings.SplitN(scanner.Text(), ", ", 5)
		if len(parts) < 5 {
			continue
		}
		idx, _       := strconv.Atoi(strings.TrimSpace(parts[0]))
		name         := strings.TrimSpace(parts[1])
		totalMiB, _  := strconv.ParseInt(strings.TrimSpace(parts[2]), 10, 64)
		usedMiB, _   := strconv.ParseInt(strings.TrimSpace(parts[3]), 10, 64)
		freeMiB, _   := strconv.ParseInt(strings.TrimSpace(parts[4]), 10, 64)

		const mib = 1024 * 1024
		gpus = append(gpus, GPUInfo{
			Index:          idx,
			Vendor:         "nvidia",
			Name:           name,
			VRAMTotalBytes: totalMiB * mib,
			VRAMUsedBytes:  usedMiB * mib,
			VRAMFreeBytes:  freeMiB * mib,
		})
	}
	return gpus
}

// sysfsGPUs discovers AMD and Intel GPUs via /sys/class/drm/card*/device.
// AMD: amdgpu driver exposes mem_info_vram_total / mem_info_vram_used.
// Intel Arc: xe driver exposes the same sysfs nodes.
// Intel integrated (i915): no mem_info files — reported as integrated.
func sysfsGPUs() []GPUInfo {
	matches, _ := filepath.Glob("/sys/class/drm/card*/device")
	var gpus []GPUInfo
	idx := 0

	for _, d := range matches {
		vendorID := readSysfsHex(filepath.Join(d, "vendor"))
		switch vendorID {
		case 0x1002: // AMD
			gpus = append(gpus, amdCard(idx, d))
			idx++
		case 0x8086: // Intel
			gpus = append(gpus, intelCard(idx, d))
			idx++
		// 0x10DE = NVIDIA — handled by nvidia-smi above; skip
		}
	}
	return gpus
}

func amdCard(idx int, d string) GPUInfo {
	name := lspciName(d)
	if name == "" {
		name = fmt.Sprintf("AMD GPU %d", idx)
	}
	total := readSysfsInt64(filepath.Join(d, "mem_info_vram_total"))
	used  := readSysfsInt64(filepath.Join(d, "mem_info_vram_used"))
	return GPUInfo{
		Index:          idx,
		Vendor:         "amd",
		Name:           name,
		VRAMTotalBytes: total,
		VRAMUsedBytes:  used,
		VRAMFreeBytes:  total - used,
	}
}

func intelCard(idx int, d string) GPUInfo {
	name := lspciName(d)
	if name == "" {
		name = fmt.Sprintf("Intel GPU %d", idx)
	}
	total := readSysfsInt64(filepath.Join(d, "mem_info_vram_total"))
	used  := readSysfsInt64(filepath.Join(d, "mem_info_vram_used"))

	// If sysfs has no VRAM data (i915 integrated), try xpu-smi for Arc cards.
	if total == 0 {
		if xpuTotal, xpuUsed, ok := xpuSmiMemory(idx); ok {
			total = xpuTotal
			used  = xpuUsed
		}
	}

	integrated := total == 0
	return GPUInfo{
		Index:          idx,
		Vendor:         "intel",
		Name:           name,
		VRAMTotalBytes: total,
		VRAMUsedBytes:  used,
		VRAMFreeBytes:  total - used,
		Integrated:     integrated,
	}
}

// xpuSmiMemory tries to read VRAM for a device index from xpu-smi.
// Returns (total, used, ok). Metrics 18/19 = GPU Memory Used / Physical Used (MiB).
func xpuSmiMemory(devIdx int) (int64, int64, bool) {
	out, err := exec.Command("xpu-smi", "dump",
		"-d", strconv.Itoa(devIdx),
		"-m", "18,19",
		"-n", "1").Output()
	if err != nil {
		return 0, 0, false
	}

	// Output is CSV: Timestamp,DeviceId,GPU Memory Used (MiB),GPU Memory Physical Used (MiB)
	scanner := bufio.NewScanner(bytes.NewReader(out))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "Timestamp") {
			continue
		}
		parts := strings.Split(line, ",")
		if len(parts) < 4 {
			continue
		}
		usedMiB, err := strconv.ParseInt(strings.TrimSpace(parts[2]), 10, 64)
		if err != nil {
			continue
		}
		totalMiB, err := strconv.ParseInt(strings.TrimSpace(parts[3]), 10, 64)
		if err != nil {
			continue
		}
		const mib = 1024 * 1024
		return totalMiB * mib, usedMiB * mib, true
	}
	return 0, 0, false
}

// lspciName resolves a PCI slot from the drm device symlink and returns the
// human-readable device name via lspci. Falls back to empty string.
func lspciName(devicePath string) string {
	// devicePath is like /sys/class/drm/card0/device
	// Resolve symlink to get the real PCI path, e.g. .../0000:03:00.0
	real, err := filepath.EvalSymlinks(devicePath)
	if err != nil {
		return ""
	}
	// Extract PCI address (last path component of parent)
	pci := filepath.Base(real)
	out, err := exec.Command("lspci", "-s", pci, "-mm").Output()
	if err != nil {
		return ""
	}
	// lspci -mm output: Slot "Class" "Vendor" "Device" ...
	scanner := bufio.NewScanner(bytes.NewReader(out))
	for scanner.Scan() {
		parts := splitLspci(scanner.Text())
		if len(parts) >= 4 {
			vendor := strings.TrimSpace(parts[2])
			device := strings.TrimSpace(parts[3])
			if vendor != "" && device != "" {
				return vendor + " " + device
			}
		}
	}
	return ""
}

// splitLspci splits lspci -mm output (fields are space-separated or quoted).
func splitLspci(line string) []string {
	var parts []string
	inQuote := false
	cur := &strings.Builder{}
	for _, c := range line {
		switch {
		case c == '"':
			inQuote = !inQuote
		case c == ' ' && !inQuote:
			if cur.Len() > 0 {
				parts = append(parts, cur.String())
				cur.Reset()
			}
		default:
			cur.WriteRune(c)
		}
	}
	if cur.Len() > 0 {
		parts = append(parts, cur.String())
	}
	return parts
}

func readSysfsInt64(path string) int64 {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	v, _ := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
	return v
}

func readSysfsHex(path string) uint64 {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	s := strings.TrimPrefix(strings.TrimSpace(string(data)), "0x")
	v, _ := strconv.ParseUint(s, 16, 64)
	return v
}
