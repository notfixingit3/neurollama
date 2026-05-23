package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// OllamaModel represents a model listed by the /api/tags endpoint
type OllamaModel struct {
	Name       string       `json:"name"`
	ModifiedAt time.Time    `json:"modified_at"`
	Size       int64        `json:"size"`
	Digest     string       `json:"digest"`
	Details    ModelDetails `json:"details"`
}

type ModelDetails struct {
	Format            string   `json:"format"`
	Family            string   `json:"family"`
	Families          []string `json:"families"`
	ParameterSize     string   `json:"parameter_size"`
	QuantizationLevel string   `json:"quantization_level"`
}

type TagsResponse struct {
	Models []OllamaModel `json:"models"`
}

type VersionResponse struct {
	Version string `json:"version"`
}

type ShowResponse struct {
	License    string                 `json:"license"`
	Modelfile  string                 `json:"modelfile"`
	Parameters string                 `json:"parameters"`
	Template   string                 `json:"template"`
	System     string                 `json:"system"`
	Details    ModelDetails           `json:"details"`
	ModelInfo  map[string]interface{} `json:"model_info"`
}

type PullProgress struct {
	Status    string `json:"status"`
	Digest    string `json:"digest,omitempty"`
	Total     int64  `json:"total,omitempty"`
	Completed int64  `json:"completed,omitempty"`
}

type authTransport struct {
	underlying http.RoundTripper
	authType   string
	token      string
	username   string
	password   string
	headerName string
	headerVal  string
}

func (t *authTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	// Add auth headers depending on type
	switch t.authType {
	case "bearer":
		if t.token != "" {
			req.Header.Set("Authorization", "Bearer "+t.token)
		}
	case "basic":
		if t.username != "" || t.password != "" {
			req.SetBasicAuth(t.username, t.password)
		}
	case "custom":
		if t.headerName != "" {
			req.Header.Set(t.headerName, t.headerVal)
		}
	}
	return t.underlying.RoundTrip(req)
}

// OllamaClient interfaces with an Ollama Server
type OllamaClient struct {
	BaseURL    string
	HTTPClient *http.Client
}

func NewOllamaClient(srv Server) *OllamaClient {
	transport := &authTransport{
		underlying: http.DefaultTransport,
		authType:   srv.AuthType,
		token:      srv.AuthToken,
		username:   srv.AuthUsername,
		password:   srv.AuthPassword,
		headerName: srv.AuthHeaderName,
		headerVal:  srv.AuthHeaderVal,
	}

	return &OllamaClient{
		BaseURL: srv.URL,
		HTTPClient: &http.Client{
			Timeout:   10 * time.Second,
			Transport: transport,
		},
	}
}

// CheckStatus verifies connection to Ollama and returns version and latency
func (c *OllamaClient) CheckStatus() (string, time.Duration, error) {
	start := time.Now()
	resp, err := c.HTTPClient.Get(fmt.Sprintf("%s/api/version", c.BaseURL))
	latency := time.Since(start)
	if err != nil {
		return "", 0, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", latency, fmt.Errorf("unexpected status code: %d", resp.StatusCode)
	}

	var verResp VersionResponse
	if err := json.NewDecoder(resp.Body).Decode(&verResp); err != nil {
		return "", latency, fmt.Errorf("failed to parse version: %w", err)
	}

	return verResp.Version, latency, nil
}

// ListModels fetches available models via /api/tags
func (c *OllamaClient) ListModels() ([]OllamaModel, error) {
	resp, err := c.HTTPClient.Get(fmt.Sprintf("%s/api/tags", c.BaseURL))
	if err != nil {
		return nil, fmt.Errorf("failed to connect to Ollama: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status code: %d", resp.StatusCode)
	}

	var tagsResp TagsResponse
	if err := json.NewDecoder(resp.Body).Decode(&tagsResp); err != nil {
		return nil, fmt.Errorf("failed to parse tags response: %w", err)
	}

	return tagsResp.Models, nil
}

// GetModelDetails fetches info about a specific model via /api/show
func (c *OllamaClient) GetModelDetails(name string) (*ShowResponse, error) {
	reqBody, err := json.Marshal(map[string]string{"name": name})
	if err != nil {
		return nil, err
	}

	resp, err := c.HTTPClient.Post(
		fmt.Sprintf("%s/api/show", c.BaseURL),
		"application/json",
		bytes.NewBuffer(reqBody),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to Ollama: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		// Read error response if any
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("unexpected status code %d: %s", resp.StatusCode, string(bodyBytes))
	}

	var showResp ShowResponse
	if err := json.NewDecoder(resp.Body).Decode(&showResp); err != nil {
		return nil, fmt.Errorf("failed to parse show response: %w", err)
	}

	return &showResp, nil
}

// DeleteModel removes a model via /api/delete
func (c *OllamaClient) DeleteModel(name string) error {
	reqBody, err := json.Marshal(map[string]string{"name": name})
	if err != nil {
		return err
	}

	req, err := http.NewRequest(
		http.MethodDelete,
		fmt.Sprintf("%s/api/delete", c.BaseURL),
		bytes.NewBuffer(reqBody),
	)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to connect to Ollama: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("failed to delete model, status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	return nil
}

// CopyModel duplicates a model via /api/copy
func (c *OllamaClient) CopyModel(source, destination string) error {
	reqBody, err := json.Marshal(map[string]string{
		"source":      source,
		"destination": destination,
	})
	if err != nil {
		return err
	}

	resp, err := c.HTTPClient.Post(
		fmt.Sprintf("%s/api/copy", c.BaseURL),
		"application/json",
		bytes.NewBuffer(reqBody),
	)
	if err != nil {
		return fmt.Errorf("failed to connect to Ollama: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("failed to copy model, status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	return nil
}

// StreamPullModel issues a pull request and writes the raw bytes stream to an output channel
func (c *OllamaClient) StreamPullModel(ctx context.Context, name string) (io.ReadCloser, error) {
	reqBody, err := json.Marshal(map[string]interface{}{
		"name":   name,
		"stream": true,
	})
	if err != nil {
		return nil, err
	}

	// Use a client without short timeout for long pulling process
	longClient := &http.Client{
		Transport: c.HTTPClient.Transport,
	}
	req, err := http.NewRequestWithContext(ctx, "POST", fmt.Sprintf("%s/api/pull", c.BaseURL), bytes.NewBuffer(reqBody))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := longClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to start pull request: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("failed to pull model, status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	return resp.Body, nil
}

// ParsePullProgress reads lines from the stream reader and parses them
func ParsePullProgress(reader io.Reader, handler func(PullProgress) bool) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var progress PullProgress
		if err := json.Unmarshal(line, &progress); err != nil {
			// If it's not valid JSON, we just skip or log
			continue
		}

		if !handler(progress) {
			break
		}
	}
	return scanner.Err()
}

// ProcessModel represents an active model running in memory
type ProcessModel struct {
	Name      string       `json:"name"`
	Model     string       `json:"model"`
	Size      int64        `json:"size"`
	Digest    string       `json:"digest"`
	Details   ModelDetails `json:"details"`
	ExpiresAt time.Time    `json:"expires_at"`
	SizeVRAM  int64        `json:"size_vram"`
}

type ProcessResponse struct {
	Models []ProcessModel `json:"models"`
}

type ChatMessage struct {
	Role    string   `json:"role"`
	Content string   `json:"content"`
	Images  []string `json:"images,omitempty"`
}

type ChatRequest struct {
	Model    string                 `json:"model"`
	Messages []ChatMessage          `json:"messages"`
	Stream   bool                   `json:"stream"`
	Options  map[string]interface{} `json:"options,omitempty"`
}

type GenerateRequest struct {
	Model    string                 `json:"model"`
	Prompt   string                 `json:"prompt"`
	System   string                 `json:"system,omitempty"`
	Template string                 `json:"template,omitempty"`
	Stream   bool                   `json:"stream"`
	Options  map[string]interface{} `json:"options,omitempty"`
}

type CreateRequest struct {
	Name      string `json:"name"`
	Modelfile string `json:"modelfile"`
	Stream    bool   `json:"stream"`
}

// ListActiveModels fetches running models via /api/ps
func (c *OllamaClient) ListActiveModels() ([]ProcessModel, error) {
	resp, err := c.HTTPClient.Get(fmt.Sprintf("%s/api/ps", c.BaseURL))
	if err != nil {
		return nil, fmt.Errorf("failed to connect to Ollama: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status code: %d", resp.StatusCode)
	}

	var psResp ProcessResponse
	if err := json.NewDecoder(resp.Body).Decode(&psResp); err != nil {
		return nil, fmt.Errorf("failed to parse ps response: %w", err)
	}

	return psResp.Models, nil
}

// UnloadModel forces Ollama to unload a model from memory (VRAM)
func (c *OllamaClient) UnloadModel(name string) error {
	reqBody, err := json.Marshal(map[string]interface{}{
		"model":      name,
		"messages":   []ChatMessage{},
		"keep_alive": 0,
	})
	if err != nil {
		return err
	}

	resp, err := c.HTTPClient.Post(
		fmt.Sprintf("%s/api/chat", c.BaseURL),
		"application/json",
		bytes.NewBuffer(reqBody),
	)
	if err != nil {
		return fmt.Errorf("failed to contact Ollama for unload: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("failed to unload model, status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	return nil
}

// StreamChat issues a chat generation stream request
func (c *OllamaClient) StreamChat(ctx context.Context, chatReq ChatRequest) (io.ReadCloser, error) {
	reqBody, err := json.Marshal(chatReq)
	if err != nil {
		return nil, err
	}

	longClient := &http.Client{
		Transport: c.HTTPClient.Transport,
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("%s/api/chat", c.BaseURL), bytes.NewBuffer(reqBody))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := longClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to start chat stream: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("chat stream failed, status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	return resp.Body, nil
}

// StreamGenerate issues a raw text completion generation stream request
func (c *OllamaClient) StreamGenerate(ctx context.Context, genReq GenerateRequest) (io.ReadCloser, error) {
	reqBody, err := json.Marshal(genReq)
	if err != nil {
		return nil, err
	}

	longClient := &http.Client{
		Transport: c.HTTPClient.Transport,
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("%s/api/generate", c.BaseURL), bytes.NewBuffer(reqBody))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := longClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to start generate stream: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("generate stream failed, status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	return resp.Body, nil
}

// StreamCreate issues a model creation request
func (c *OllamaClient) StreamCreate(ctx context.Context, createReq CreateRequest) (io.ReadCloser, error) {
	reqBody, err := json.Marshal(createReq)
	if err != nil {
		return nil, err
	}

	longClient := &http.Client{
		Transport: c.HTTPClient.Transport,
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("%s/api/create", c.BaseURL), bytes.NewBuffer(reqBody))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := longClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to start model build: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("model build failed, status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	return resp.Body, nil
}

// GetEmbeddings retrieves vector representations of texts using active Ollama server, trying /api/embed first then /api/embeddings.
// Uses a 5-minute timeout so cold model loads (which can take 30s+) don't cause spurious failures.
func (c *OllamaClient) GetEmbeddings(model string, inputs []string) ([][]float64, error) {
	reqBody, err := json.Marshal(map[string]interface{}{
		"model": model,
		"input": inputs,
	})
	if err != nil {
		return nil, err
	}

	longClient := &http.Client{
		Transport: c.HTTPClient.Transport,
		Timeout:   5 * time.Minute,
	}

	resp, err := longClient.Post(
		fmt.Sprintf("%s/api/embed", c.BaseURL),
		"application/json",
		bytes.NewBuffer(reqBody),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to Ollama: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusOK {
		var embedResp struct {
			Embeddings [][]float64 `json:"embeddings"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&embedResp); err != nil {
			return nil, fmt.Errorf("failed to parse embed response: %w", err)
		}
		return embedResp.Embeddings, nil
	}

	// Fallback to older /api/embeddings endpoint (which takes one prompt string at a time)
	embeddings := make([][]float64, len(inputs))
	for i, input := range inputs {
		reqBodyOld, err := json.Marshal(map[string]string{
			"model":  model,
			"prompt": input,
		})
		if err != nil {
			return nil, err
		}

		respOld, err := longClient.Post(
			fmt.Sprintf("%s/api/embeddings", c.BaseURL),
			"application/json",
			bytes.NewBuffer(reqBodyOld),
		)
		if err != nil {
			return nil, fmt.Errorf("failed to connect to Ollama fallback: %w", err)
		}

		if respOld.StatusCode != http.StatusOK {
			bodyBytes, readErr := io.ReadAll(respOld.Body)
			closeErr := respOld.Body.Close()
			if readErr != nil {
				return nil, fmt.Errorf("fallback embeddings failed with status %d and unreadable response body: %w", respOld.StatusCode, readErr)
			}
			if closeErr != nil {
				return nil, fmt.Errorf("failed to close fallback embedding response: %w", closeErr)
			}
			return nil, fmt.Errorf("fallback embeddings failed with status %d: %s", respOld.StatusCode, string(bodyBytes))
		}

		var embedRespOld struct {
			Embedding []float64 `json:"embedding"`
		}
		decodeErr := json.NewDecoder(respOld.Body).Decode(&embedRespOld)
		closeErr := respOld.Body.Close()
		if decodeErr != nil {
			return nil, fmt.Errorf("failed to parse fallback embedding: %w", decodeErr)
		}
		if closeErr != nil {
			return nil, fmt.Errorf("failed to close fallback embedding response: %w", closeErr)
		}
		embeddings[i] = embedRespOld.Embedding
	}

	return embeddings, nil
}
