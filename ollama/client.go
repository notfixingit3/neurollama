// Package ollama provides a client for the Ollama API.
package ollama

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// OllamaModel represents a model in the Ollama registry.
type OllamaModel struct {
	Name       string
	Quant      string
	SizeBytes  int64
	SizeString string
}

// ModelInfo contains detailed information about a model.
type ModelInfo struct {
	Modelfile  string         `json:"modelfile"`
	Parameters string         `json:"parameters"`
	Template   string         `json:"template"`
	Details    ModelDetails   `json:"details"`
	ModelInfo  map[string]any `json:"model_info"`
}

// ModelDetails describes the technical attributes of a model.
type ModelDetails struct {
	ParentModel       string   `json:"parent_model"`
	Format            string   `json:"format"`
	Family            string   `json:"family"`
	Families          []string `json:"families"`
	ParameterSize     string   `json:"parameter_size"`
	QuantizationLevel string   `json:"quantization_level"`
}

var httpClient = &http.Client{Timeout: 10 * time.Second}

// FetchModels returns the list of models from the given Ollama server.
func FetchModels(baseURL string) []OllamaModel {
	resp, err := httpClient.Get(baseURL + "/api/tags")
	if err != nil {
		return nil
	}
	defer resp.Body.Close()

	var result struct {
		Models []struct {
			Name    string `json:"name"`
			Size    int64  `json:"size"`
			Details struct {
				QuantizationLevel string `json:"quantization_level"`
			} `json:"details"`
		} `json:"models"`
	}
	json.NewDecoder(resp.Body).Decode(&result)

	var list []OllamaModel
	for _, m := range result.Models {
		q := m.Details.QuantizationLevel
		if q == "" {
			q = "N/A"
		}
		list = append(list, OllamaModel{
			Name:       m.Name,
			Quant:      q,
			SizeBytes:  m.Size,
			SizeString: formatBytes(m.Size),
		})
	}
	return list
}

// FetchVersion returns the version string of the Ollama server.
func FetchVersion(baseURL string) string {
	resp, err := httpClient.Get(baseURL + "/api/version")
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	var result struct {
		Version string `json:"version"`
	}
	json.NewDecoder(resp.Body).Decode(&result)
	return result.Version
}

// FetchModelInfo returns detailed information about a specific model.
func FetchModelInfo(baseURL string, name string) (*ModelInfo, error) {
	body := map[string]string{"name": name}
	data, _ := json.Marshal(body)
	resp, err := httpClient.Post(baseURL+"/api/show", "application/json", bytes.NewBuffer(data))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var info ModelInfo
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return nil, err
	}
	return &info, nil
}

// PullModel downloads a model and waits for completion.
func PullModel(baseURL string, input string) error {
	body := map[string]string{"name": input}
	data, _ := json.Marshal(body)
	resp, err := httpClient.Post(baseURL+"/api/pull", "application/json", bytes.NewBuffer(data))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("pull failed with status %d", resp.StatusCode)
	}
	return nil
}

// PullModelStream initiates a model pull and returns the response body
// for SSE streaming. The caller must close the returned ReadCloser.
func PullModelStream(baseURL string, input string) (io.ReadCloser, error) {
	body := map[string]string{"name": input}
	data, _ := json.Marshal(body)
	resp, err := httpClient.Post(baseURL+"/api/pull", "application/json", bytes.NewBuffer(data))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("pull failed with status %d", resp.StatusCode)
	}
	return resp.Body, nil
}

// DeleteModel removes a model from the Ollama server.
func DeleteModel(baseURL string, name string) {
	body := map[string]string{"name": name}
	data, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodDelete, baseURL+"/api/delete", bytes.NewBuffer(data))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	httpClient.Do(req)
}

func formatBytes(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}
