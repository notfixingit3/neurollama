//go:build linux

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
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

	// xe driver on most kernels doesn't expose mem_info_vram_total in sysfs.
	// i915 driver (often used for Arc on older kernels) also doesn't expose it.
	// Priority for total: xpu-smi → /proc/iomem xe regions → lspci BAR → PCI device ID table.
	// Priority for used: xpu-smi → intel_gpu_top -J (sums drm-total-local*).
	if total == 0 {
		if xpuTotal, xpuUsed, ok := xpuSmiMemory(idx); ok {
			total = xpuTotal
			used  = xpuUsed
		} else {
			if iomemTotal := intelIOmemVRAM(d); iomemTotal > 0 {
				total = iomemTotal
			} else if barTotal := lspciBarSize(d); barTotal > 0 {
				total = barTotal
			} else if knownTotal := intelKnownVRAMBytes(d); knownTotal > 0 {
				// Fallback for i915-driven Arc cards with small/disabled BARs:
				// read PCI device ID and look up in a table of known VRAM sizes.
				total = knownTotal
			}
			if gpuUsed := intelGPUTopUsed(); gpuUsed > 0 {
				used = gpuUsed
			}
		}
	}

	// Arc / DG1 / DG2 are discrete even when VRAM is undetectable (e.g. VFIO passthrough).
	integrated := !isIntelDiscreteGPU(name) && total == 0
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

// isIntelDiscreteGPU returns true for Intel discrete GPU product names.
// Used to avoid misclassifying passthrough/VFIO cards with undetectable VRAM as integrated.
func isIntelDiscreteGPU(name string) bool {
	lower := strings.ToLower(name)
	return strings.Contains(lower, "arc") ||
		strings.Contains(lower, " dg1") ||
		strings.Contains(lower, " dg2") ||
		strings.Contains(lower, "iris xe max") ||
		strings.Contains(lower, "iris pro")
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

// intelGPUTopUsed sums per-client LMEM (local memory = VRAM on Arc) usage
// reported by intel_gpu_top -J. Returns 0 if the tool is unavailable or the
// output cannot be parsed.
//
// Note: older versions of intel_gpu_top do not support the -n (count) flag, so
// we use a context timeout and collect whatever JSON samples arrive in 2.5 s.
func intelGPUTopUsed() int64 {
	ctx, cancel := context.WithTimeout(context.Background(), 2500*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, "intel_gpu_top", "-J", "-s", "200")
	out, _ := cmd.Output() // error expected on context cancel; ignore
	if len(out) == 0 {
		return 0
	}

	type memField struct {
		Value float64 `json:"value"`
		Unit  string  `json:"unit"`
	}
	type client struct {
		Memory map[string]memField `json:"memory"`
	}
	type snapshot struct {
		Clients []client `json:"clients"`
	}

	// intel_gpu_top -J emits one JSON object per sample, one per line.
	// Scan from the end to find the last fully-parseable line.
	raw := bytes.TrimSpace(out)
	var snap snapshot
	lines := bytes.Split(raw, []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		line := bytes.TrimSpace(lines[i])
		if len(line) == 0 {
			continue
		}
		if json.Unmarshal(line, &snap) == nil {
			break
		}
		snap = snapshot{} // reset on bad parse, keep scanning
	}

	var totalKiB float64
	for _, c := range snap.Clients {
		for key, f := range c.Memory {
			if !strings.Contains(key, "local") {
				continue
			}
			val := f.Value
			switch strings.ToLower(f.Unit) {
			case "mib", "mb":
				val *= 1024
			case "gib", "gb":
				val *= 1024 * 1024
			case "bytes", "b":
				val /= 1024
			}
			totalKiB += val
		}
	}
	if totalKiB <= 0 {
		return 0
	}
	return int64(totalKiB * 1024)
}

// intelKnownVRAMBytes reads the PCI device ID from sysfs and returns the
// physical VRAM capacity for known Intel discrete GPU SKUs.
// This handles Arc cards running under the i915 driver with Resizable BAR
// disabled — in that configuration neither xe sysfs nor /proc/iomem expose
// the full VRAM, and lspci only shows a small aperture BAR (≤ 256 MB).
func intelKnownVRAMBytes(devicePath string) int64 {
	const GiB = 1024 * 1024 * 1024
	// PCI device ID → VRAM bytes for Intel discrete GPU SKUs.
	// Arc A-series: consumer desktop / workstation cards.
	// Arc Pro: workstation add-in cards (A40 and A50 share device ID 0x56b1).
	known := map[uint64]int64{
		0x56a5: 6 * GiB,  // Arc A380 (6 GB GDDR6)
		0x56a6: 4 * GiB,  // Arc A310 (4 GB GDDR6)
		0x5692: 8 * GiB,  // Arc A580 (8 GB GDDR6)
		0x5691: 8 * GiB,  // Arc A750 (8 GB GDDR6)
		0x5690: 16 * GiB, // Arc A770 (16 GB GDDR6)
		0x5694: 4 * GiB,  // Arc A370M (4 GB)
		0x5693: 4 * GiB,  // Arc A530M (4 GB)
		0x5695: 4 * GiB,  // Arc A350M (4 GB)
		0x56b0: 4 * GiB,  // Arc Pro A30M (4 GB)
		// 0x56b1 covers both A40 (6 GB) and A50 (8 GB) — ambiguous, skip
	}
	devFile := filepath.Join(devicePath, "device")
	devID := readSysfsHex(devFile)
	if devID == 0 {
		return 0
	}
	return known[devID]
}

// intelIOmemVRAM reads /proc/iomem to find the physical VRAM size claimed by
// the xe driver for a given drm device. This is more accurate than the PCI BAR
// size, which rounds up to the next power of 2 (e.g. 8 GiB BAR for a 6 GiB
// Arc A380). The xe driver labels its region as "xe [vram region N]" or
// "xe [lmem region N]" and only claims the bytes actually backed by DRAM.
func intelIOmemVRAM(devicePath string) int64 {
	real, err := filepath.EvalSymlinks(devicePath)
	if err != nil {
		return 0
	}
	pciAddr := strings.ToLower(filepath.Base(real))

	data, err := os.ReadFile("/proc/iomem")
	if err != nil {
		return 0
	}

	devIndent := -1
	for _, line := range strings.Split(string(data), "\n") {
		if line == "" {
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " "))

		// Leaving the device's scope
		if devIndent >= 0 && indent <= devIndent {
			devIndent = -1
		}

		// Found our PCI device line (may appear more than once; keep the last)
		if strings.Contains(strings.ToLower(line), pciAddr) &&
			!strings.Contains(strings.ToLower(line), "xe [") {
			devIndent = indent
			continue
		}

		// Child lines within our device: look for xe VRAM region labels
		if devIndent >= 0 && indent > devIndent {
			lower := strings.ToLower(line)
			if strings.Contains(lower, "xe [") || strings.Contains(lower, "i915 [") {
				parts := strings.SplitN(strings.TrimSpace(line), " : ", 2)
				addrs := strings.SplitN(parts[0], "-", 2)
				if len(addrs) == 2 {
					start, e1 := strconv.ParseUint(addrs[0], 16, 64)
					end,   e2 := strconv.ParseUint(addrs[1], 16, 64)
					const minVRAM = 512 * 1024 * 1024
					size := end - start + 1
					if e1 == nil && e2 == nil && size >= minVRAM {
						return int64(size)
					}
				}
			}
		}
	}
	return 0
}

// lspciBarSize reads the largest prefetchable PCI BAR for a drm device via
// "lspci -v". For discrete GPUs this corresponds to the VRAM aperture size.
// Returns 0 if lspci is unavailable or the BAR cannot be determined.
func lspciBarSize(devicePath string) int64 {
	real, err := filepath.EvalSymlinks(devicePath)
	if err != nil {
		return 0
	}
	pci := filepath.Base(real)
	out, err := exec.Command("lspci", "-v", "-s", pci).Output()
	if err != nil {
		return 0
	}
	var largest int64
	scanner := bufio.NewScanner(bytes.NewReader(out))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.Contains(line, "prefetchable") || !strings.Contains(line, "size=") {
			continue
		}
		idx := strings.LastIndex(line, "size=")
		if idx < 0 {
			continue
		}
		sizeStr := strings.TrimSuffix(line[idx+5:], "]")
		var bytes int64
		switch {
		case strings.HasSuffix(sizeStr, "G"):
			v, _ := strconv.ParseInt(strings.TrimSuffix(sizeStr, "G"), 10, 64)
			bytes = v * 1024 * 1024 * 1024
		case strings.HasSuffix(sizeStr, "M"):
			v, _ := strconv.ParseInt(strings.TrimSuffix(sizeStr, "M"), 10, 64)
			bytes = v * 1024 * 1024
		case strings.HasSuffix(sizeStr, "K"):
			v, _ := strconv.ParseInt(strings.TrimSuffix(sizeStr, "K"), 10, 64)
			bytes = v * 1024
		}
		// Only count BARs >= 512 MiB — smaller BARs are control registers, not VRAM.
		if bytes >= 512*1024*1024 && bytes > largest {
			largest = bytes
		}
	}
	return largest
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
