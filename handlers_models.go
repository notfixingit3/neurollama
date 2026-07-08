package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// getModelsHandler returns the model list from the background cache.
// Optional query params:
//   - node=<id>   serve a specific node's cache (default: active server)
//   - page=N      1-based page number (default 1)
//   - limit=N     page size 1–200 (default 0 = return all)
func getModelsHandler(c *gin.Context) {
	// Resolve which server to serve.
	var srv Server
	if nodeID := c.Query("node"); nodeID != "" {
		found := false
		for _, s := range GetServers() {
			if s.ID == nodeID {
				srv = s
				found = true
				break
			}
		}
		if !found {
			c.JSON(http.StatusNotFound, gin.H{"error": "node not found"})
			return
		}
	} else {
		var err error
		srv, err = GetActiveServer()
		if err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "No active Ollama server selected"})
			return
		}
	}

	// Read from cache; fall back to live call on cold-start.
	nodeModelMu.RLock()
	entry, ok := nodeModelCache[srv.ID]
	nodeModelMu.RUnlock()

	var allModels []OllamaModel
	var updatedAt time.Time
	fromCache := ok

	if ok {
		allModels = entry.models
		updatedAt = entry.updatedAt
	} else {
		client := NewOllamaClient(srv)
		live, err := client.ListModels(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{
				"error":     fmt.Sprintf("Failed to contact Ollama server (%s)", srv.URL),
				"details":   err.Error(),
				"serverUrl": srv.URL,
			})
			return
		}
		allModels = live
		updatedAt = time.Now()
		nodeModelMu.Lock()
		nodeModelCache[srv.ID] = modelCacheEntry{models: live, updatedAt: updatedAt}
		nodeModelMu.Unlock()
	}

	total := len(allModels)

	// Parse pagination params.
	page, limit := 1, 0
	if p, err := strconv.Atoi(c.Query("page")); err == nil && p > 0 {
		page = p
	}
	if l, err := strconv.Atoi(c.Query("limit")); err == nil && l > 0 {
		if l > 200 {
			l = 200
		}
		limit = l
	}

	var pageModels []OllamaModel
	if limit > 0 {
		start := (page - 1) * limit
		if start >= total {
			pageModels = []OllamaModel{}
		} else {
			end := start + limit
			if end > total {
				end = total
			}
			pageModels = allModels[start:end]
		}
	} else {
		pageModels = allModels
	}

	c.JSON(http.StatusOK, gin.H{
		"models":      pageModels,
		"total":       total,
		"page":        page,
		"limit":       limit,
		"serverUrl":   srv.URL,
		"lastUpdated": updatedAt.Unix(),
		"fromCache":   fromCache,
	})
}

// ModelSearchResult wraps an OllamaModel with the node it was found on.
type ModelSearchResult struct {
	OllamaModel
	NodeID   string `json:"node_id"`
	NodeName string `json:"node_name"`
}

// searchModelsHandler walks every nodeModelCache entry and returns models
// whose name contains the query string (case-insensitive).
// GET /api/models/search?q=llama3&nodes=all
// GET /api/models/search?q=gemma&nodes=id1,id2
func searchModelsHandler(c *gin.Context) {
	q := strings.ToLower(strings.TrimSpace(c.Query("q")))
	if q == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "q parameter is required"})
		return
	}

	nodesParam := strings.TrimSpace(c.Query("nodes"))
	allowedNodes := map[string]bool{}
	if nodesParam != "" && nodesParam != "all" {
		for _, id := range strings.Split(nodesParam, ",") {
			if id = strings.TrimSpace(id); id != "" {
				allowedNodes[id] = true
			}
		}
	}

	// Build id → name lookup.
	serverNames := map[string]string{}
	for _, s := range GetServers() {
		serverNames[s.ID] = s.Name
	}

	var results []ModelSearchResult
	nodeModelMu.RLock()
	for nodeID, entry := range nodeModelCache {
		if len(allowedNodes) > 0 && !allowedNodes[nodeID] {
			continue
		}
		for _, m := range entry.models {
			if strings.Contains(strings.ToLower(m.Name), q) {
				results = append(results, ModelSearchResult{
					OllamaModel: m,
					NodeID:      nodeID,
					NodeName:    serverNames[nodeID],
				})
			}
		}
	}
	nodeModelMu.RUnlock()

	sort.Slice(results, func(i, j int) bool {
		if results[i].NodeName != results[j].NodeName {
			return results[i].NodeName < results[j].NodeName
		}
		return results[i].Name < results[j].Name
	})

	c.JSON(http.StatusOK, gin.H{
		"results": results,
		"total":   len(results),
		"query":   q,
	})
}

// getModelDetailHandler gets detailed info of a model
func getModelDetailHandler(c *gin.Context) {
	name := c.Query("name")
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Model name is required"})
		return
	}

	activeSrv, err := GetActiveServer()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "No active Ollama server selected"})
		return
	}

	client := NewOllamaClient(activeSrv)
	details, err := client.GetModelDetails(c.Request.Context(), name)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, details)
}

// modelCtxLengthsHandler returns a map of model_name → trained context length
// by fanning out parallel /api/show calls for every model on the active server.
func modelCtxLengthsHandler(c *gin.Context) {
	activeSrv, err := GetActiveServer()
	if err != nil {
		c.JSON(http.StatusOK, gin.H{}) // graceful empty response
		return
	}
	client := NewOllamaClient(activeSrv)

	modelList, err := client.ListModels(c.Request.Context())
	if err != nil || len(modelList) == 0 {
		c.JSON(http.StatusOK, gin.H{})
		return
	}

	type result struct {
		name string
		ctx  int64
	}
	ch := make(chan result, len(modelList))
	var wg sync.WaitGroup
	for _, m := range modelList {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			details, err := client.GetModelDetails(c.Request.Context(), name)
			if err != nil {
				ch <- result{name, 0}
				return
			}
			// Context length is stored as {family}.context_length in model_info
			var ctxLen int64
			for k, v := range details.ModelInfo {
				if strings.HasSuffix(k, ".context_length") {
					switch n := v.(type) {
					case float64:
						ctxLen = int64(n)
					case int64:
						ctxLen = n
					}
					break
				}
			}
			ch <- result{name, ctxLen}
		}(m.Name)
	}
	wg.Wait()
	close(ch)

	out := make(map[string]int64, len(modelList))
	for r := range ch {
		if r.ctx > 0 {
			out[r.name] = r.ctx
		}
	}
	c.JSON(http.StatusOK, out)
}

// modelCapabilitiesHandler returns a map of model_name → []string of Ollama-reported
// capabilities (e.g. "completion", "tools", "vision", "thinking", "embedding") sourced
// from /api/show for every model on the active server.  Fanned out in parallel.
func modelCapabilitiesHandler(c *gin.Context) {
	activeSrv, err := GetActiveServer()
	if err != nil {
		c.JSON(http.StatusOK, gin.H{})
		return
	}
	client := NewOllamaClient(activeSrv)

	modelList, err := client.ListModels(c.Request.Context())
	if err != nil || len(modelList) == 0 {
		c.JSON(http.StatusOK, gin.H{})
		return
	}

	type result struct {
		name string
		caps []string
	}
	ch := make(chan result, len(modelList))
	var wg sync.WaitGroup
	for _, m := range modelList {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			details, err := client.GetModelDetails(c.Request.Context(), name)
			if err != nil || details == nil || len(details.Capabilities) == 0 {
				ch <- result{name, nil}
				return
			}
			ch <- result{name, details.Capabilities}
		}(m.Name)
	}
	wg.Wait()
	close(ch)

	out := make(map[string][]string, len(modelList))
	for r := range ch {
		if len(r.caps) > 0 {
			out[r.name] = r.caps
		}
	}
	c.JSON(http.StatusOK, out)
}

// deleteModelsHandler deletes a batch of models
func deleteModelsHandler(c *gin.Context) {
	var req BatchDeleteRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	activeSrv, err := GetActiveServer()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "No active Ollama server selected"})
		return
	}

	client := NewOllamaClient(activeSrv)
	errors := make(map[string]string)
	successes := []string{}

	for _, name := range req.Names {
		if err := client.DeleteModel(c.Request.Context(), name); err != nil {
			errors[name] = err.Error()
		} else {
			successes = append(successes, name)
		}
	}

	if len(successes) > 0 {
		invalidateNodeModelCache(activeSrv.ID)
		LogActivity("model", fmt.Sprintf("Deleted %d model(s): %s", len(successes), strings.Join(successes, ", ")))
	}

	if len(errors) > 0 {
		c.JSON(http.StatusMultiStatus, gin.H{
			"successes": successes,
			"errors":    errors,
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message":   "All models deleted successfully",
		"successes": successes,
	})
}

type CopyModelRequest struct {
	Source      string `json:"source" binding:"required"`
	Destination string `json:"destination" binding:"required"`
}

func copyModelHandler(c *gin.Context) {
	var req CopyModelRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	activeSrv, err := GetActiveServer()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "No active Ollama server selected"})
		return
	}

	client := NewOllamaClient(activeSrv)
	if err := client.CopyModel(c.Request.Context(), req.Source, req.Destination); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}

	invalidateNodeModelCache(activeSrv.ID)
	LogActivity("model", fmt.Sprintf("Model cloned: %s → %s", req.Source, req.Destination))
	c.JSON(http.StatusOK, gin.H{"message": "Model cloned successfully"})
}

// pullModelSSEHandler streams the pull process as Server-Sent Events
func pullModelSSEHandler(c *gin.Context) {
	name := c.Query("name")
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Model name is required"})
		return
	}

	activeSrv, err := GetActiveServer()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "No active Ollama server selected"})
		return
	}

	client := NewOllamaClient(activeSrv)
	ctx := c.Request.Context()
	stream, err := client.StreamPullModel(ctx, name)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}

	var closeOnce sync.Once
	closeStream := func(reason string) {
		closeOnce.Do(func() {
			if closeErr := stream.Close(); closeErr != nil {
				log.Printf("Warning: failed to close pull stream after %s: %v", reason, closeErr)
			}
		})
	}
	defer closeStream("request")

	// Launch a goroutine to close the stream on client disconnect
	go func() {
		<-ctx.Done()
		closeStream("client disconnect")
	}()

	// Set headers for SSE streaming
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("Transfer-Encoding", "chunked")

	srvID := activeSrv.ID
	LogActivity("pull", fmt.Sprintf("Pull started: %s", name))
	c.Stream(func(w io.Writer) bool {
		err := ParsePullProgress(stream, func(progress PullProgress) bool {
			data, err := json.Marshal(progress)
			if err == nil {
				c.SSEvent("progress", string(data))
				return true
			}
			return false
		})
		if err != nil {
			LogActivity("pull", fmt.Sprintf("Pull failed: %s — %s", name, err.Error()))
			c.SSEvent("error", err.Error())
		} else {
			invalidateNodeModelCache(srvID)
			LogActivity("pull", fmt.Sprintf("Pull completed: %s", name))
			c.SSEvent("success", "Model pull completed successfully")
		}
		return false
	})
}

// Handlers for v0.0.2

func getActiveModelsHandler(c *gin.Context) {
	activeSrv, err := GetActiveServer()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "No active Ollama server selected"})
		return
	}

	client := NewOllamaClient(activeSrv)
	activeModels, err := client.ListActiveModels(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, activeModels)
}

type UnloadRequest struct {
	Name string `json:"name" binding:"required"`
}

func unloadModelHandler(c *gin.Context) {
	var req UnloadRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	activeSrv, err := GetActiveServer()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "No active Ollama server selected"})
		return
	}

	client := NewOllamaClient(activeSrv)
	if err := client.UnloadModel(c.Request.Context(), req.Name); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}

	LogActivity("model", fmt.Sprintf("Model ejected from VRAM: %s", req.Name))
	c.JSON(http.StatusOK, gin.H{"message": "Model unloaded successfully"})
}

func getModelCardHandler(c *gin.Context) {
	name := c.Query("name")
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name parameter is required"})
		return
	}

	// 1. Check if Hugging Face model
	if strings.Contains(name, "hf.co/") || strings.Contains(name, "/") {
		cleaned := strings.TrimPrefix(name, "hf.co/")
		parts := strings.Split(cleaned, ":")
		repo := parts[0]

		url := fmt.Sprintf("https://huggingface.co/%s/raw/main/README.md", repo)
		httpClient := &http.Client{Timeout: 8 * time.Second}
		resp, err := httpClient.Get(url)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("Failed to fetch Hugging Face README: %v", err)})
			return
		}
		defer func() { _ = resp.Body.Close() }()

		if resp.StatusCode != http.StatusOK {
			// Fallback to master
			urlFallback := fmt.Sprintf("https://huggingface.co/%s/raw/master/README.md", repo)
			respFallback, err := httpClient.Get(urlFallback)
			if err == nil {
				defer func() { _ = respFallback.Body.Close() }()
				if respFallback.StatusCode == http.StatusOK {
					body, _ := io.ReadAll(respFallback.Body)
					c.String(http.StatusOK, string(body))
					return
				}
			}
			c.JSON(resp.StatusCode, gin.H{"error": fmt.Sprintf("Hugging Face raw README returned status: %d", resp.StatusCode)})
			return
		}

		body, err := io.ReadAll(resp.Body)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to read body: %v", err)})
			return
		}
		c.String(http.StatusOK, string(body))
		return
	}

	// 2. Otherwise Ollama Library model
	parts := strings.Split(name, ":")
	baseName := parts[0]

	url := fmt.Sprintf("https://ollama.com/library/%s", baseName)
	httpClient := &http.Client{Timeout: 8 * time.Second}
	resp, err := httpClient.Get(url)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("Failed to fetch Ollama Library page: %v", err)})
		return
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		c.JSON(resp.StatusCode, gin.H{"error": fmt.Sprintf("Ollama Library page returned status: %d", resp.StatusCode)})
		return
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to read body: %v", err)})
		return
	}

	c.String(http.StatusOK, string(body))
}

// POST /api/models/probe-json — probe whether a model reliably outputs valid JSON.
func probeJSONHandler(c *gin.Context) {
	var req struct {
		Model string `json:"model" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	activeSrv, err := GetActiveServer()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "No active server"})
		return
	}
	client := NewOllamaClient(activeSrv)
	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()
	chatReq := ChatRequest{
		Model: req.Model,
		Messages: []ChatMessage{
			{Role: "user", Content: `Return a JSON object with exactly these fields: {"name": "test", "value": 42, "active": true}`},
		},
		Stream: false,
		Format: "json",
		Options: map[string]interface{}{"temperature": 0.0, "num_predict": 200},
	}
	result, err := client.ChatWithTools(ctx, chatReq)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"pass": false, "error": err.Error()})
		return
	}
	var parsed interface{}
	pass := json.Unmarshal([]byte(strings.TrimSpace(result.Message.Content)), &parsed) == nil
	c.JSON(http.StatusOK, gin.H{"pass": pass, "response": result.Message.Content})
}
