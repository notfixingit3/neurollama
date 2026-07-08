package main

import (
	"testing"
)

func TestVectorSerialization(t *testing.T) {
	// Original high-precision float64 slice (typical embedding values)
	original := []float64{0.15432, -0.987654, 0.0, 3.1415926, -0.000123}

	// 1. Convert float64 to float32 little-endian bytes
	blob := float64SliceToBytes(original)

	// Since float32 consumes 4 bytes, length of blob must be exactly len(original) * 4
	expectedBytes := len(original) * 4
	if len(blob) != expectedBytes {
		t.Fatalf("Expected byte length of %d, got %d", expectedBytes, len(blob))
	}

	// 2. Convert bytes back to float64 slice
	decoded, err := bytesToFloat64Slice(blob)
	if err != nil {
		t.Fatalf("Failed to decode binary vector: %v", err)
	}

	if len(decoded) != len(original) {
		t.Fatalf("Decoded vector length mismatch: expected %d, got %d", len(original), len(decoded))
	}

	// 3. Assert values are preserved within float32 precision limits (epsilon 1e-6)
	const epsilon = 1e-6
	for i := range original {
		diff := original[i] - decoded[i]
		if diff < -epsilon || diff > epsilon {
			t.Errorf("Value mismatch at index %d: original %f, decoded %f (diff: %g)", i, original[i], decoded[i], diff)
		}
	}

	// 4. Test corruption handling (must reject uneven byte sizes)
	corruptBlob := append(blob, 0x00) // Adds 1 extra byte (uneven 4-byte boundaries)
	_, err = bytesToFloat64Slice(corruptBlob)
	if err == nil {
		t.Error("Expected error when decoding uneven byte slice, got nil")
	}
}
