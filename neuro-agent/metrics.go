package main

import (
	"os"
	"runtime"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/mem"
)

type AgentMetrics struct {
	Hostname      string    `json:"hostname"`
	OS            string    `json:"os"`
	Arch          string    `json:"arch"`
	UptimeSeconds uint64    `json:"uptime_seconds"`
	CPU           CPUInfo   `json:"cpu"`
	Memory        MemInfo   `json:"memory"`
	GPUs          []GPUInfo `json:"gpus"`
	AgentVersion  string    `json:"agent_version"`
	CollectedAt   time.Time `json:"collected_at"`
}

type CPUInfo struct {
	Model        string  `json:"model"`
	Cores        int     `json:"cores"`
	UsagePercent float64 `json:"usage_percent"`
}

type MemInfo struct {
	TotalBytes     uint64 `json:"total_bytes"`
	UsedBytes      uint64 `json:"used_bytes"`
	AvailableBytes uint64 `json:"available_bytes"`
}

type GPUInfo struct {
	Index          int    `json:"index"`
	Vendor         string `json:"vendor"` // nvidia | amd | intel | apple | unknown
	Name           string `json:"name"`
	VRAMTotalBytes int64  `json:"vram_total_bytes"`
	VRAMUsedBytes  int64  `json:"vram_used_bytes"`
	VRAMFreeBytes  int64  `json:"vram_free_bytes"`
	Integrated     bool   `json:"integrated"`
}

func collectMetrics() (*AgentMetrics, error) {
	hostname, _ := os.Hostname()

	var uptime uint64
	if hi, err := host.Info(); err == nil {
		uptime = hi.Uptime
	}

	cpuInfo := collectCPU()

	var memInfo MemInfo
	if vm, err := mem.VirtualMemory(); err == nil {
		memInfo = MemInfo{
			TotalBytes:     vm.Total,
			UsedBytes:      vm.Used,
			AvailableBytes: vm.Available,
		}
	}

	return &AgentMetrics{
		Hostname:      hostname,
		OS:            runtime.GOOS,
		Arch:          runtime.GOARCH,
		UptimeSeconds: uptime,
		CPU:           cpuInfo,
		Memory:        memInfo,
		GPUs:          collectGPUs(),
		AgentVersion:  agentVersion,
		CollectedAt:   time.Now().UTC(),
	}, nil
}

func collectCPU() CPUInfo {
	info := CPUInfo{Cores: runtime.NumCPU()}

	if cpus, err := cpu.Info(); err == nil && len(cpus) > 0 {
		info.Model = cpus[0].ModelName
	}

	// 150ms sample — fast enough for a metrics endpoint
	if pcts, err := cpu.Percent(150*time.Millisecond, false); err == nil && len(pcts) > 0 {
		info.UsagePercent = pcts[0]
	}

	return info
}
