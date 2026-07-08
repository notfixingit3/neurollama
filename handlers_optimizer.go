package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// Hyperparameter Optimizer Handlers

func runOptimizerForConfig(ctx context.Context, client *OllamaClient, model string, prompt string, temp, topP float64, topK int) (float64, float64, float64, string, error) {
	req := GenerateRequest{
		Model:  model,
		Prompt: prompt,
		Stream: true,
		Options: map[string]interface{}{
			"temperature": temp,
			"top_p":       topP,
			"top_k":       topK,
		},
	}

	start := time.Now()
	stream, err := client.StreamGenerate(ctx, req)
	if err != nil {
		return 0, 0, 0, "", err
	}
	defer func() { _ = stream.Close() }()

	var firstTokenTime time.Duration
	var firstTokenReceived bool
	var tokenCount int
	var sb strings.Builder

	scanner := newStreamScanner(stream)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var chunk struct {
			Response string `json:"response"`
			Done     bool   `json:"done"`
		}
		if err := json.Unmarshal(line, &chunk); err == nil {
			if !firstTokenReceived && chunk.Response != "" {
				firstTokenTime = time.Since(start)
				firstTokenReceived = true
			}
			if chunk.Response != "" {
				tokenCount++
				sb.WriteString(chunk.Response)
			}
		}
	}

	totalDuration := time.Since(start)

	if !firstTokenReceived {
		return 0, 0, 0, "", fmt.Errorf("no tokens received from model")
	}

	ttftMs := float64(firstTokenTime.Milliseconds())
	generationDurationSec := totalDuration.Seconds() - firstTokenTime.Seconds()
	if generationDurationSec <= 0 {
		generationDurationSec = 0.001
	}
	tps := float64(tokenCount) / generationDurationSec
	avgLatency := float64(totalDuration.Milliseconds())

	return ttftMs, tps, avgLatency, sb.String(), nil
}

func runOptimizerSSEHandler(c *gin.Context) {
	model := c.Query("model")
	if model == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Model parameter is required"})
		return
	}

	prompt := c.Query("prompt")
	if prompt == "" {
		prompt = "Write a detailed paragraph explaining the main benefits of modular programming."
	}

	activeSrv, err := GetActiveServer()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "No active Ollama server selected"})
		return
	}

	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("Transfer-Encoding", "chunked")

	client := NewOllamaClient(activeSrv)
	ctx := c.Request.Context()

	type ConfigSet struct {
		Name string
		Temp float64
		TopP float64
		TopK int
	}

	configs := []ConfigSet{
		{"Set 1 (Precise)", 0.2, 0.5, 20},
		{"Set 2 (Balanced)", 0.7, 0.9, 40},
		{"Set 3 (Creative)", 1.2, 0.95, 60},
	}

	LogActivity("optimizer", fmt.Sprintf("Optimizer started: %s", model))
	c.Stream(func(w io.Writer) bool {
		c.SSEvent("status", fmt.Sprintf("Initializing Hyperparameter Optimizer for %s...", model))
		c.SSEvent("status", fmt.Sprintf("Test Prompt: \"%s\"", prompt))

		for i, cfg := range configs {
			c.SSEvent("status", fmt.Sprintf("Running Configuration Set %d/3: %s (Temp: %.1f, TopP: %.2f, TopK: %d)", i+1, cfg.Name, cfg.Temp, cfg.TopP, cfg.TopK))

			ttft, tps, latency, text, err := runOptimizerForConfig(ctx, client, model, prompt, cfg.Temp, cfg.TopP, cfg.TopK)
			if err != nil {
				c.SSEvent("error", fmt.Sprintf("Configuration %d failed: %v", i+1, err))
				continue
			}

			preview := text
			if len(preview) > 120 {
				preview = preview[:120] + "..."
			}

			id, err := SaveOptimizerRun(activeSrv.Name, activeSrv.URL, model, cfg.Temp, cfg.TopP, cfg.TopK, ttft, tps, latency, prompt, preview)
			if err != nil {
				c.SSEvent("error", fmt.Sprintf("Failed to save run to DB: %v", err))
			}

			resultPayload := map[string]interface{}{
				"id":          id,
				"server_name": activeSrv.Name,
				"server_url":  activeSrv.URL,
				"model_name":  model,
				"config_name": cfg.Name,
				"temperature": cfg.Temp,
				"top_p":       cfg.TopP,
				"top_k":       cfg.TopK,
				"ttft_ms":     ttft,
				"tps":         tps,
				"avg_latency": latency,
				"preview":     preview,
			}

			resBytes, _ := json.Marshal(resultPayload)
			c.SSEvent("config_result", string(resBytes))
		}

		LogActivity("optimizer", fmt.Sprintf("Optimizer completed: %s", model))
		c.SSEvent("done", "Optimization run completed successfully.")
		return false
	})
}

func getOptimizerRunsHandler(c *gin.Context) {
	runs, err := GetOptimizerRuns()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, runs)
}

func deleteOptimizerRunHandler(c *gin.Context) {
	idStr := c.Param("id")
	var id int64
	if _, err := fmt.Sscanf(idStr, "%d", &id); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid run ID"})
		return
	}

	err := DeleteOptimizerRun(id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Optimizer run deleted successfully"})
}

func getGroupedOptimizerRunsHandler(c *gin.Context) {
	groups, err := GetGroupedOptimizerRuns()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, groups)
}
