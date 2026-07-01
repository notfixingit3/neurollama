//go:build darwin

package main

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

func collectGPUs() []GPUInfo {
	out, err := exec.Command("system_profiler", "SPDisplaysDataType", "-json").Output()
	if err != nil {
		return nil
	}

	var raw struct {
		SPDisplaysDataType []map[string]any `json:"SPDisplaysDataType"`
	}
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil
	}

	var gpus []GPUInfo
	for i, d := range raw.SPDisplaysDataType {
		name   := stringField(d, "sppci_model", "spdisplays_device-id", fmt.Sprintf("GPU %d", i))
		vendor := detectMacVendor(stringField(d, "spdisplays_vendor", "sppci_vendor", ""), name)

		// VRAM: discrete cards report spdisplays_vram; Apple Silicon reports
		// spdisplays_vram_shared (dynamic unified memory allocation).
		vramStr    := stringField(d, "spdisplays_vram", "")
		sharedStr  := stringField(d, "spdisplays_vram_shared", "")
		integrated := vramStr == "" // no dedicated VRAM → integrated / unified

		totalBytes := parseVRAMString(vramStr)
		if totalBytes == 0 {
			totalBytes = parseVRAMString(sharedStr)
		}

		gpus = append(gpus, GPUInfo{
			Index:          i,
			Vendor:         vendor,
			Name:           name,
			VRAMTotalBytes: totalBytes,
			// Used/free not available from system_profiler without root
			Integrated: integrated,
		})
	}
	return gpus
}

func detectMacVendor(vendor, name string) string {
	s := strings.ToLower(vendor + " " + name)
	switch {
	case strings.Contains(s, "nvidia"):
		return "nvidia"
	case strings.Contains(s, "amd") || strings.Contains(s, "radeon"):
		return "amd"
	case strings.Contains(s, "intel"):
		return "intel"
	case strings.Contains(s, "apple"):
		return "apple"
	}
	return "unknown"
}

// stringField returns the first non-empty string value for the given keys.
func stringField(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			if s, ok := v.(string); ok && s != "" {
				return s
			}
		}
	}
	return ""
}

// parseVRAMString converts strings like "16 GB", "512 MB" to bytes.
func parseVRAMString(s string) int64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	var val float64
	var unit string
	fmt.Sscanf(s, "%f %s", &val, &unit)
	switch strings.ToUpper(unit) {
	case "GB":
		return int64(val * 1024 * 1024 * 1024)
	case "MB":
		return int64(val * 1024 * 1024)
	case "TB":
		return int64(val * 1024 * 1024 * 1024 * 1024)
	}
	return 0
}
