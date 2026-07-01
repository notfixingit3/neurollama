//go:build !linux && !darwin

package main

// collectGPUs is a stub for platforms other than Linux and macOS.
func collectGPUs() []GPUInfo { return nil }
