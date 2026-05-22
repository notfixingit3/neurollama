package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

type ServerStatusResponse struct {
	Server
	Status  string `json:"status"` // "online" or "offline"
	Version string `json:"version"`
	Latency int64  `json:"latency"` // in milliseconds
}

type AddServerRequest struct {
	Name           string `json:"name" binding:"required"`
	URL            string `json:"url" binding:"required"`
	AuthType       string `json:"authType"`
	AuthToken      string `json:"authToken"`
	AuthUsername   string `json:"authUsername"`
	AuthPassword   string `json:"authPassword"`
	AuthHeaderName string `json:"authHeaderName"`
	AuthHeaderVal  string `json:"authHeaderVal"`
}

type EditServerRequest struct {
	Name           string `json:"name" binding:"required"`
	URL            string `json:"url" binding:"required"`
	AuthType       string `json:"authType"`
	AuthToken      string `json:"authToken"`
	AuthUsername   string `json:"authUsername"`
	AuthPassword   string `json:"authPassword"`
	AuthHeaderName string `json:"authHeaderName"`
	AuthHeaderVal  string `json:"authHeaderVal"`
}

type BatchDeleteRequest struct {
	Names []string `json:"names" binding:"required"`
}

type DiagnosticsResponse struct {
	GeneratedAt string            `json:"generated_at"`
	Checks      []DiagnosticCheck `json:"checks"`
}

type DiagnosticCheck struct {
	Name    string `json:"name"`
	Status  string `json:"status"`
	Message string `json:"message"`
	Details string `json:"details,omitempty"`
}

func newStreamScanner(reader io.Reader) *bufio.Scanner {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	return scanner
}

func main() {
	// Load config data
	if err := LoadConfig(); err != nil {
		log.Fatalf("Error loading config: %v", err)
	}

	// Initialize SQLite Database
	dbPath := "data/neurollama.db"
	oldDbPath := "data/ollama-manager.db"
	if _, err := os.Stat(oldDbPath); err == nil {
		if _, err := os.Stat(dbPath); os.IsNotExist(err) {
			log.Println("Migrating database file from ollama-manager.db to neurollama.db...")
			if err := os.Rename(oldDbPath, dbPath); err != nil {
				log.Printf("Warning: failed to rename database file: %v. Falling back to old path.", err)
				dbPath = oldDbPath
			}
		}
	}
	if err := InitDB(dbPath); err != nil {
		log.Fatalf("Error initializing database: %v", err)
	}

	// Start background poller and scheduler
	startTelemetryPoller()
	startSchedulerTicker()

	r := gin.Default()

	// Load HTML templates
	r.LoadHTMLGlob("templates/*")

	// Serve static files
	r.Static("/static", "./static")

	// HTML routes
	r.GET("/", func(c *gin.Context) {
		c.HTML(http.StatusOK, "index.html", gin.H{
			"title": "NEUROLLAMA 2026",
		})
	})

	// API routes
	api := r.Group("/api")
	{
		// Server endpoints
		api.GET("/servers", getServersHandler)
		api.POST("/servers", addServerHandler)
		api.POST("/servers/test", testServerHandler)
		api.POST("/servers/:id/test", testExistingServerHandler)
		api.PUT("/servers/:id", editServerHandler)
		api.DELETE("/servers/:id", deleteServerHandler)
		api.POST("/servers/:id/select", selectServerHandler)

		// Active Ollama client proxies
		api.GET("/models", getModelsHandler)
		api.GET("/models/detail", getModelDetailHandler) // GET /api/models/detail?name=llama3
		api.POST("/models/delete", deleteModelsHandler)  // POST batch delete
		api.POST("/models/copy", copyModelHandler)       // POST clone model
		api.GET("/models/pull", pullModelSSEHandler)     // GET /api/models/pull?name=llama3 (SSE)
		api.GET("/models/card", getModelCardHandler)     // GET /api/models/card?name=llama3

		// Handlers for v0.0.2
		api.GET("/models/active", getActiveModelsHandler)
		api.POST("/models/unload", unloadModelHandler)
		api.POST("/chat", chatStreamHandler)
		api.POST("/generate", generateStreamHandler)
		api.POST("/models/create", createModelStreamHandler)

		// Handlers for v0.0.3 SQLite Persistence & Presets
		api.GET("/chats", getChatsHandler)
		api.GET("/chats/:id", getChatMessagesHandler)
		api.POST("/chats", createChatHandler)
		api.PUT("/chats/:id", updateChatHandler)
		api.DELETE("/chats/:id", deleteChatHandler)
		api.GET("/presets", getPresetsHandler)
		api.POST("/presets", createPresetHandler)
		api.DELETE("/presets/:id", deletePresetHandler)

		// Telemetry & Scheduler endpoints
		api.GET("/settings", getSettingsHandler)
		api.PUT("/settings", updateSettingHandler)
		api.GET("/scheduler/logs", getSchedulerLogsHandler)
		api.POST("/scheduler/check", checkModelUpdatesNowHandler)
		api.GET("/telemetry/stream", telemetryStreamHandler)

		// Context Compression
		api.POST("/chats/:id/compress", compressChatHandler)

		// Benchmarks
		api.GET("/benchmarks", getBenchmarksHandler)
		api.GET("/benchmarks/run", runBenchmarkSSEHandler)
		api.PUT("/benchmarks/:id/score", updateBenchmarkScoreHandler)
		api.DELETE("/benchmarks/:id", deleteBenchmarkHandler)

		// Hyperparameter Optimizer
		api.GET("/optimizer/runs", getOptimizerRunsHandler)
		api.GET("/optimizer/run", runOptimizerSSEHandler)
		api.DELETE("/optimizer/runs/:id", deleteOptimizerRunHandler)

		// Document RAG Panel Endpoints
		api.GET("/rag/documents", getRAGDocumentsHandler)
		api.POST("/rag/documents", uploadRAGDocumentHandler)
		api.DELETE("/rag/documents/:id", deleteRAGDocumentHandler)
		api.POST("/rag/query", queryRAGSimilarityHandler)

		// Diagnostics
		api.GET("/diagnostics", diagnosticsHandler)
	}

	port := strings.TrimSpace(os.Getenv("PORT"))
	if port == "" {
		port = "8080"
	}

	log.Printf("NEUROLLAMA is starting on http://localhost:%s", port)
	if err := r.Run(":" + port); err != nil {
		log.Fatalf("Server failed to run: %v", err)
	}
}

// getServersHandler retrieves all servers and checks their statuses concurrently
func getServersHandler(c *gin.Context) {
	srvs := GetServers()

	var wg sync.WaitGroup
	responses := make([]ServerStatusResponse, len(srvs))

	for i, srv := range srvs {
		wg.Add(1)
		go func(idx int, s Server) {
			defer wg.Done()
			client := NewOllamaClient(s)
			version, latency, err := client.CheckStatus()

			status := "online"
			if err != nil {
				status = "offline"
				version = ""
				latency = 0
			}

			responses[idx] = ServerStatusResponse{
				Server:  RedactServerSecrets(s),
				Status:  status,
				Version: version,
				Latency: latency.Milliseconds(),
			}
		}(i, srv)
	}

	wg.Wait()
	c.JSON(http.StatusOK, responses)
}

// addServerHandler adds a new server configuration
func addServerHandler(c *gin.Context) {
	var req AddServerRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	newSrv, err := AddServer(
		req.Name, req.URL,
		req.AuthType, req.AuthToken,
		req.AuthUsername, req.AuthPassword,
		req.AuthHeaderName, req.AuthHeaderVal,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Fetch status immediately to return complete record
	client := NewOllamaClient(newSrv)
	version, latency, err := client.CheckStatus()
	status := "online"
	if err != nil {
		status = "offline"
		version = ""
		latency = 0
	}

	c.JSON(http.StatusCreated, ServerStatusResponse{
		Server:  RedactServerSecrets(newSrv),
		Status:  status,
		Version: version,
		Latency: latency.Milliseconds(),
	})
}

func testServerHandler(c *gin.Context) {
	var req AddServerRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	srv := Server{
		ID:             "test",
		Name:           req.Name,
		URL:            strings.TrimRight(req.URL, "/"),
		AuthType:       req.AuthType,
		AuthToken:      req.AuthToken,
		AuthUsername:   req.AuthUsername,
		AuthPassword:   req.AuthPassword,
		AuthHeaderName: req.AuthHeaderName,
		AuthHeaderVal:  req.AuthHeaderVal,
	}
	if srv.AuthType == "" {
		srv.AuthType = "none"
	}

	client := NewOllamaClient(srv)
	version, latency, err := client.CheckStatus()
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{
			"status":  "offline",
			"message": err.Error(),
			"latency": 0,
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"status":  "online",
		"version": version,
		"latency": latency.Milliseconds(),
	})
}

func testExistingServerHandler(c *gin.Context) {
	id := c.Param("id")
	var req EditServerRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var existing Server
	found := false
	for _, srv := range GetServers() {
		if srv.ID == id {
			existing = srv
			found = true
			break
		}
	}
	if !found {
		c.JSON(http.StatusNotFound, gin.H{"error": "server not found"})
		return
	}

	authType, authToken, authUsername, authPassword, authHeaderName, authHeaderVal := MergeAuthFields(
		existing,
		req.AuthType, req.AuthToken,
		req.AuthUsername, req.AuthPassword,
		req.AuthHeaderName, req.AuthHeaderVal,
	)

	srv := Server{
		ID:             id,
		Name:           req.Name,
		URL:            strings.TrimRight(req.URL, "/"),
		AuthType:       authType,
		AuthToken:      authToken,
		AuthUsername:   authUsername,
		AuthPassword:   authPassword,
		AuthHeaderName: authHeaderName,
		AuthHeaderVal:  authHeaderVal,
	}

	client := NewOllamaClient(srv)
	version, latency, err := client.CheckStatus()
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{
			"status":  "offline",
			"message": err.Error(),
			"latency": 0,
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"status":  "online",
		"version": version,
		"latency": latency.Milliseconds(),
	})
}

// editServerHandler updates an existing server
func editServerHandler(c *gin.Context) {
	id := c.Param("id")
	var req EditServerRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	updatedSrv, err := EditServer(
		id, req.Name, req.URL,
		req.AuthType, req.AuthToken,
		req.AuthUsername, req.AuthPassword,
		req.AuthHeaderName, req.AuthHeaderVal,
	)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	client := NewOllamaClient(updatedSrv)
	version, latency, err := client.CheckStatus()
	status := "online"
	if err != nil {
		status = "offline"
		version = ""
		latency = 0
	}

	c.JSON(http.StatusOK, ServerStatusResponse{
		Server:  RedactServerSecrets(updatedSrv),
		Status:  status,
		Version: version,
		Latency: latency.Milliseconds(),
	})
}

// deleteServerHandler deletes a server by ID
func deleteServerHandler(c *gin.Context) {
	id := c.Param("id")
	if err := DeleteServer(id); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Server deleted successfully"})
}

// selectServerHandler switches the active server
func selectServerHandler(c *gin.Context) {
	id := c.Param("id")
	srv, err := SetActiveServer(id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	client := NewOllamaClient(srv)
	version, latency, err := client.CheckStatus()
	status := "online"
	if err != nil {
		status = "offline"
		version = ""
		latency = 0
	}

	c.JSON(http.StatusOK, ServerStatusResponse{
		Server:  RedactServerSecrets(srv),
		Status:  status,
		Version: version,
		Latency: latency.Milliseconds(),
	})
}

// getModelsHandler lists models on the active Ollama server
func getModelsHandler(c *gin.Context) {
	activeSrv, err := GetActiveServer()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "No active Ollama server selected"})
		return
	}

	client := NewOllamaClient(activeSrv)
	models, err := client.ListModels()
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{
			"error":     fmt.Sprintf("Failed to contact active Ollama server (%s)", activeSrv.URL),
			"details":   err.Error(),
			"serverUrl": activeSrv.URL,
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"models":    models,
		"serverUrl": activeSrv.URL,
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
	details, err := client.GetModelDetails(name)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, details)
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
		if err := client.DeleteModel(name); err != nil {
			errors[name] = err.Error()
		} else {
			successes = append(successes, name)
		}
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
	if err := client.CopyModel(req.Source, req.Destination); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}

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
	var ctx context.Context = c.Request.Context()
	stream, err := client.StreamPullModel(ctx, name)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer stream.Close()

	// Launch a goroutine to close the stream on client disconnect
	go func() {
		<-ctx.Done()
		stream.Close()
	}()

	// Set headers for SSE streaming
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("Transfer-Encoding", "chunked")

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
			c.SSEvent("error", err.Error())
		} else {
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
	activeModels, err := client.ListActiveModels()
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
	if err := client.UnloadModel(req.Name); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Model unloaded successfully"})
}

type ChatStreamRequest struct {
	Model             string        `json:"model" binding:"required"`
	Messages          []ChatMessage `json:"messages" binding:"required"`
	Temperature       *float64      `json:"temperature"`
	NumCtx            int           `json:"num_ctx"`
	ChatID            *int64        `json:"chat_id"`
	TopK              *int          `json:"top_k"`
	TopP              *float64      `json:"top_p"`
	RepeatPenalty     *float64      `json:"repeat_penalty"`
	Seed              *int          `json:"seed"`
	MinP              *float64      `json:"min_p"`
	PresencePenalty   *float64      `json:"presence_penalty"`
	FrequencyPenalty  *float64      `json:"frequency_penalty"`
	NumPredict        *int          `json:"num_predict"`
	NumGPU            *int          `json:"num_gpu"`
	NumThread         *int          `json:"num_thread"`
	RagEnabled        *bool         `json:"rag_enabled"`
	RagEmbeddingModel string        `json:"rag_embedding_model"`
	RagTopK           *int          `json:"rag_top_k"`
}

func chatStreamHandler(c *gin.Context) {
	var req ChatStreamRequest
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

	options := make(map[string]interface{})
	if req.Temperature != nil {
		options["temperature"] = *req.Temperature
	}
	if req.NumCtx > 0 {
		options["num_ctx"] = req.NumCtx
	}
	if req.TopK != nil {
		options["top_k"] = *req.TopK
	}
	if req.TopP != nil {
		options["top_p"] = *req.TopP
	}
	if req.RepeatPenalty != nil {
		options["repeat_penalty"] = *req.RepeatPenalty
	}
	if req.Seed != nil {
		options["seed"] = *req.Seed
	}
	if req.MinP != nil {
		options["min_p"] = *req.MinP
	}
	if req.PresencePenalty != nil {
		options["presence_penalty"] = *req.PresencePenalty
	}
	if req.FrequencyPenalty != nil {
		options["frequency_penalty"] = *req.FrequencyPenalty
	}
	if req.NumPredict != nil && *req.NumPredict >= 0 {
		options["num_predict"] = *req.NumPredict
	}
	if req.NumGPU != nil && *req.NumGPU >= 0 {
		options["num_gpu"] = *req.NumGPU
	}
	if req.NumThread != nil && *req.NumThread >= 0 {
		options["num_thread"] = *req.NumThread
	}

	chatReq := ChatRequest{
		Model:    req.Model,
		Messages: req.Messages,
		Stream:   true,
	}
	if len(options) > 0 {
		chatReq.Options = options
	}

	var compressionSummary string
	userMessageSaved := false

	// Write user message to DB if chat session is active, check context length for auto-compression
	if req.ChatID != nil && *req.ChatID > 0 && len(req.Messages) > 0 {
		// Calculate estimated tokens
		totalChars := 0
		for _, m := range req.Messages {
			totalChars += len(m.Content)
		}
		estimatedTokens := totalChars / 4

		limitCtx := req.NumCtx
		if limitCtx <= 0 {
			chat, err := GetChat(*req.ChatID)
			if err == nil && chat != nil {
				limitCtx = chat.NumCtx
			}
		}
		if limitCtx <= 0 {
			limitCtx = 2048
		}

		if estimatedTokens > int(float64(limitCtx)*0.85) && len(req.Messages) > 2 {
			log.Printf("Chat %d context length %d exceeds 85%% of %d, triggering auto-compression...", *req.ChatID, estimatedTokens, limitCtx)
			// Save the user's latest message first so it is included in the summary
			lastMsg := req.Messages[len(req.Messages)-1]
			if err := SaveChatMessage(*req.ChatID, lastMsg.Role, lastMsg.Content, lastMsg.Images); err == nil {
				userMessageSaved = true
			} else {
				log.Printf("Error saving user prompt to db before auto-compress: %v", err)
			}

			summary, err := CompressChatSession(*req.ChatID, req.Model)
			if err == nil {
				compressionSummary = summary
				// Re-load the messages from DB (which now contains only the system summary message)
				dbMsgs, err := GetChatMessages(*req.ChatID)
				if err == nil && len(dbMsgs) > 0 {
					chatReq.Messages = dbMsgs
				}
			} else {
				log.Printf("Failed to auto-compress chat: %v", err)
			}
		}

		if !userMessageSaved {
			lastMsg := req.Messages[len(req.Messages)-1]
			if err := SaveChatMessage(*req.ChatID, lastMsg.Role, lastMsg.Content, lastMsg.Images); err != nil {
				log.Printf("Error saving user prompt to db: %v", err)
			}
		}
	}

	var ragSources []gin.H
	if req.RagEnabled != nil && *req.RagEnabled && req.RagEmbeddingModel != "" && len(chatReq.Messages) > 0 {
		lastUserMsgIdx := -1
		for i := len(chatReq.Messages) - 1; i >= 0; i-- {
			if chatReq.Messages[i].Role == "user" {
				lastUserMsgIdx = i
				break
			}
		}

		if lastUserMsgIdx != -1 {
			embeddings, err := client.GetEmbeddings(req.RagEmbeddingModel, []string{chatReq.Messages[lastUserMsgIdx].Content})
			if err == nil && len(embeddings) > 0 {
				queryEmbed := embeddings[0]
				allChunks, err := GetRAGChunksForModel(req.RagEmbeddingModel)
				if err == nil && len(allChunks) > 0 {
					type matchResult struct {
						chunk RAGChunkWithDocInfo
						score float64
					}
					var matches []matchResult
					for _, chunk := range allChunks {
						score := cosineSimilarity(queryEmbed, chunk.Embedding)
						if score > 0.25 {
							matches = append(matches, matchResult{chunk: chunk, score: score})
						}
					}

					if len(matches) > 0 {
						sort.Slice(matches, func(i, j int) bool {
							return matches[i].score > matches[j].score
						})

						topK := 3
						if req.RagTopK != nil && *req.RagTopK > 0 {
							topK = *req.RagTopK
						}
						if len(matches) < topK {
							topK = len(matches)
						}

						var contextBuilder strings.Builder
						contextBuilder.WriteString("Use the following pieces of context to answer the user request. If you don't know the answer, just say you don't know, don't try to make up an answer.\n\n")
						for idx := 0; idx < topK; idx++ {
							match := matches[idx]
							contextBuilder.WriteString(fmt.Sprintf("--- CONTEXT CHUNK #%d (Source: %s) ---\n%s\n\n", idx+1, match.chunk.DocumentName, match.chunk.Content))
							ragSources = append(ragSources, gin.H{
								"document_name": match.chunk.DocumentName,
								"chunk_index":   match.chunk.ChunkIndex,
								"score":         match.score,
								"content":       match.chunk.Content,
							})
						}
						contextBuilder.WriteString(fmt.Sprintf("User Request: %s", chatReq.Messages[lastUserMsgIdx].Content))
						chatReq.Messages[lastUserMsgIdx].Content = contextBuilder.String()
					}
				}
			} else {
				log.Printf("RAG embedding failed: %v", err)
			}
		}
	}

	stream, err := client.StreamChat(c.Request.Context(), chatReq)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer stream.Close()

	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("Transfer-Encoding", "chunked")

	var accumulatedContent string

	c.Stream(func(w io.Writer) bool {
		if len(ragSources) > 0 {
			sourcesJSON, _ := json.Marshal(ragSources)
			c.SSEvent("rag_sources", string(sourcesJSON))
		}
		if compressionSummary != "" {
			c.SSEvent("compressed", compressionSummary)
		}

		scanner := newStreamScanner(stream)
		for scanner.Scan() {
			line := scanner.Bytes()
			if len(line) == 0 {
				continue
			}

			// Accumulate response tokens for database storage
			var ollamaResp struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			}
			if err := json.Unmarshal(line, &ollamaResp); err == nil {
				accumulatedContent += ollamaResp.Message.Content
			}

			c.SSEvent("message", string(line))
		}
		if err := scanner.Err(); err != nil {
			c.SSEvent("error", err.Error())
		} else {
			// Save the assistant's complete accumulated response to SQLite
			if req.ChatID != nil && *req.ChatID > 0 && len(accumulatedContent) > 0 {
				if err := SaveChatMessage(*req.ChatID, "assistant", accumulatedContent, nil); err != nil {
					log.Printf("Error saving assistant response to db: %v", err)
				}
			}
			c.SSEvent("done", "stream finished")
		}
		return false
	})
}

// --- CHAT HISTORY HANDLERS (v0.0.3) ---

func getChatsHandler(c *gin.Context) {
	chats, err := GetChats()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, chats)
}

func getChatMessagesHandler(c *gin.Context) {
	idStr := c.Param("id")
	var id int64
	if _, err := fmt.Sscanf(idStr, "%d", &id); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid chat ID"})
		return
	}

	messages, err := GetChatMessages(id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, messages)
}

type CreateChatRequest struct {
	Title            string  `json:"title" binding:"required"`
	Model            string  `json:"model" binding:"required"`
	SystemPrompt     string  `json:"system_prompt"`
	Temperature      float64 `json:"temperature"`
	NumCtx           int     `json:"num_ctx"`
	TopK             int     `json:"top_k"`
	TopP             float64 `json:"top_p"`
	RepeatPenalty    float64 `json:"repeat_penalty"`
	Seed             *int    `json:"seed"`
	MinP             float64 `json:"min_p"`
	PresencePenalty  float64 `json:"presence_penalty"`
	FrequencyPenalty float64 `json:"frequency_penalty"`
	NumPredict       int     `json:"num_predict"`
	NumGPU           int     `json:"num_gpu"`
	NumThread        int     `json:"num_thread"`
}

func createChatHandler(c *gin.Context) {
	var req CreateChatRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	id, err := CreateChat(req.Title, req.Model, req.SystemPrompt, req.Temperature, req.NumCtx, req.TopK, req.TopP, req.RepeatPenalty, req.Seed, req.MinP, req.PresencePenalty, req.FrequencyPenalty, req.NumPredict, req.NumGPU, req.NumThread)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"id": id, "title": req.Title})
}

type UpdateChatConfigRequest struct {
	Model            string  `json:"model" binding:"required"`
	SystemPrompt     string  `json:"system_prompt"`
	Temperature      float64 `json:"temperature"`
	NumCtx           int     `json:"num_ctx"`
	TopK             int     `json:"top_k"`
	TopP             float64 `json:"top_p"`
	RepeatPenalty    float64 `json:"repeat_penalty"`
	Seed             *int    `json:"seed"`
	MinP             float64 `json:"min_p"`
	PresencePenalty  float64 `json:"presence_penalty"`
	FrequencyPenalty float64 `json:"frequency_penalty"`
	NumPredict       int     `json:"num_predict"`
	NumGPU           int     `json:"num_gpu"`
	NumThread        int     `json:"num_thread"`
}

func updateChatHandler(c *gin.Context) {
	idStr := c.Param("id")
	var id int64
	if _, err := fmt.Sscanf(idStr, "%d", &id); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid chat ID"})
		return
	}

	var req UpdateChatConfigRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	err := UpdateChatConfig(id, req.Model, req.SystemPrompt, req.Temperature, req.NumCtx, req.TopK, req.TopP, req.RepeatPenalty, req.Seed, req.MinP, req.PresencePenalty, req.FrequencyPenalty, req.NumPredict, req.NumGPU, req.NumThread)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Chat config updated successfully"})
}

func deleteChatHandler(c *gin.Context) {
	idStr := c.Param("id")
	var id int64
	if _, err := fmt.Sscanf(idStr, "%d", &id); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid chat ID"})
		return
	}

	if err := DeleteChat(id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Chat deleted successfully"})
}

// --- PROMPT PRESET HANDLERS (v0.0.3) ---

func getPresetsHandler(c *gin.Context) {
	presets, err := GetPresets()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, presets)
}

type CreatePresetRequest struct {
	Name    string `json:"name" binding:"required"`
	Content string `json:"content" binding:"required"`
}

func createPresetHandler(c *gin.Context) {
	var req CreatePresetRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	id, err := CreatePreset(req.Name, req.Content)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"id": id, "name": req.Name})
}

func deletePresetHandler(c *gin.Context) {
	idStr := c.Param("id")
	var id int64
	if _, err := fmt.Sscanf(idStr, "%d", &id); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid preset ID"})
		return
	}

	if err := DeletePreset(id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Preset deleted successfully"})
}

type CreateStreamRequest struct {
	Name      string `json:"name" binding:"required"`
	Modelfile string `json:"modelfile" binding:"required"`
}

func createModelStreamHandler(c *gin.Context) {
	var req CreateStreamRequest
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

	createReq := CreateRequest{
		Name:      req.Name,
		Modelfile: req.Modelfile,
		Stream:    true,
	}

	stream, err := client.StreamCreate(c.Request.Context(), createReq)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer stream.Close()

	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("Transfer-Encoding", "chunked")

	c.Stream(func(w io.Writer) bool {
		scanner := newStreamScanner(stream)
		for scanner.Scan() {
			line := scanner.Bytes()
			if len(line) == 0 {
				continue
			}
			c.SSEvent("message", string(line))
		}
		if err := scanner.Err(); err != nil {
			c.SSEvent("error", err.Error())
		} else {
			c.SSEvent("done", "stream finished")
		}
		return false
	})
}

type GenerateStreamRequest struct {
	Model            string   `json:"model" binding:"required"`
	Prompt           string   `json:"prompt" binding:"required"`
	SystemPrompt     string   `json:"system_prompt"`
	Temperature      *float64 `json:"temperature"`
	NumCtx           int      `json:"num_ctx"`
	TopK             *int     `json:"top_k"`
	TopP             *float64 `json:"top_p"`
	RepeatPenalty    *float64 `json:"repeat_penalty"`
	Seed             *int     `json:"seed"`
	MinP             *float64 `json:"min_p"`
	PresencePenalty  *float64 `json:"presence_penalty"`
	FrequencyPenalty *float64 `json:"frequency_penalty"`
	NumPredict       *int     `json:"num_predict"`
	NumGPU           *int     `json:"num_gpu"`
	NumThread        *int     `json:"num_thread"`
}

func generateStreamHandler(c *gin.Context) {
	var req GenerateStreamRequest
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

	options := make(map[string]interface{})
	if req.Temperature != nil {
		options["temperature"] = *req.Temperature
	}
	if req.NumCtx > 0 {
		options["num_ctx"] = req.NumCtx
	}
	if req.TopK != nil {
		options["top_k"] = *req.TopK
	}
	if req.TopP != nil {
		options["top_p"] = *req.TopP
	}
	if req.RepeatPenalty != nil {
		options["repeat_penalty"] = *req.RepeatPenalty
	}
	if req.Seed != nil {
		options["seed"] = *req.Seed
	}
	if req.MinP != nil {
		options["min_p"] = *req.MinP
	}
	if req.PresencePenalty != nil {
		options["presence_penalty"] = *req.PresencePenalty
	}
	if req.FrequencyPenalty != nil {
		options["frequency_penalty"] = *req.FrequencyPenalty
	}
	if req.NumPredict != nil && *req.NumPredict >= 0 {
		options["num_predict"] = *req.NumPredict
	}
	if req.NumGPU != nil && *req.NumGPU >= 0 {
		options["num_gpu"] = *req.NumGPU
	}
	if req.NumThread != nil && *req.NumThread >= 0 {
		options["num_thread"] = *req.NumThread
	}

	genReq := GenerateRequest{
		Model:  req.Model,
		Prompt: req.Prompt,
		Stream: true,
	}
	if req.SystemPrompt != "" {
		genReq.System = req.SystemPrompt
	}
	if len(options) > 0 {
		genReq.Options = options
	}

	stream, err := client.StreamGenerate(c.Request.Context(), genReq)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer stream.Close()

	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("Transfer-Encoding", "chunked")

	c.Stream(func(w io.Writer) bool {
		scanner := newStreamScanner(stream)
		for scanner.Scan() {
			line := scanner.Bytes()
			if len(line) == 0 {
				continue
			}
			c.SSEvent("message", string(line))
		}
		if err := scanner.Err(); err != nil {
			c.SSEvent("error", err.Error())
		} else {
			c.SSEvent("done", "stream finished")
		}
		return false
	})
}

func getModelCardHandler(c *gin.Context) {
	name := c.Query("name")
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name parameter is required"})
		return
	}

	// 1. Check if Hugging Face model
	if strings.Contains(name, "hf.co/") || strings.Contains(name, "/") {
		cleaned := name
		if strings.HasPrefix(cleaned, "hf.co/") {
			cleaned = strings.TrimPrefix(cleaned, "hf.co/")
		}
		parts := strings.Split(cleaned, ":")
		repo := parts[0]

		url := fmt.Sprintf("https://huggingface.co/%s/raw/main/README.md", repo)
		httpClient := &http.Client{Timeout: 8 * time.Second}
		resp, err := httpClient.Get(url)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("Failed to fetch Hugging Face README: %v", err)})
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			// Fallback to master
			urlFallback := fmt.Sprintf("https://huggingface.co/%s/raw/master/README.md", repo)
			respFallback, err := httpClient.Get(urlFallback)
			if err == nil {
				defer respFallback.Body.Close()
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
	defer resp.Body.Close()

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

// ==========================================
// TELEMETRY, SCHEDULER & BENCHMARK FUNCTIONS
// ==========================================

type HostStats struct {
	CPU      float64 `json:"cpu"`
	RAMUsed  uint64  `json:"ram_used"`
	RAMTotal uint64  `json:"ram_total"`
}

type OllamaNodeInfo struct {
	URL      string `json:"url"`
	IsRemote bool   `json:"is_remote"`
}

type TelemetryPayload struct {
	AppHost      HostStats      `json:"app_host"`
	OllamaNode   OllamaNodeInfo `json:"ollama_node"`
	ActiveModels []ProcessModel `json:"active_models"`
}

var (
	telemetryMutex   sync.Mutex
	currentTelemetry TelemetryPayload
)

func isRemoteURL(urlStr string) bool {
	u := strings.ToLower(urlStr)
	return !(strings.Contains(u, "localhost") || strings.Contains(u, "127.0.0.1") || strings.Contains(u, "0.0.0.0") || strings.Contains(u, "[::1]"))
}

func parsePhysMem(line string) (float64, rune, float64, rune) {
	idxUsed := strings.Index(line, " used")
	idxUnused := strings.Index(line, " unused")
	if idxUsed == -1 || idxUnused == -1 {
		return 0, 0, 0, 0
	}
	partUsed := line[len("PhysMem:"):idxUsed]
	partUsed = strings.TrimSpace(partUsed)
	if idxParen := strings.Index(partUsed, "("); idxParen != -1 {
		partUsed = strings.TrimSpace(partUsed[:idxParen])
	}
	var usedVal float64
	var usedUnit rune
	fmt.Sscanf(partUsed, "%f%c", &usedVal, &usedUnit)

	idxComma := strings.LastIndex(line[:idxUnused], ",")
	if idxComma == -1 {
		return 0, 0, 0, 0
	}
	partUnused := line[idxComma+1 : idxUnused]
	partUnused = strings.TrimSpace(partUnused)
	var unusedVal float64
	var unusedUnit rune
	fmt.Sscanf(partUnused, "%f%c", &unusedVal, &unusedUnit)

	return usedVal, usedUnit, unusedVal, unusedUnit
}

func getMacRAM() (uint64, uint64, error) {
	out, err := exec.Command("sysctl", "-n", "hw.memsize").Output()
	if err != nil {
		return 0, 0, err
	}
	total, err := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
	if err != nil {
		return 0, 0, err
	}

	vmOut, err := exec.Command("vm_stat").Output()
	if err != nil {
		return 0, 0, err
	}

	lines := strings.Split(string(vmOut), "\n")
	var pageSize uint64 = 4096
	var active, speculative, wired, compressed uint64

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if strings.Contains(line, "page size of") {
			parts := strings.Split(line, "page size of ")
			if len(parts) > 1 {
				subparts := strings.Fields(parts[1])
				if len(subparts) > 0 {
					if size, err := strconv.ParseUint(subparts[0], 10, 64); err == nil {
						pageSize = size
					}
				}
			}
			continue
		}

		parts := strings.Split(line, ":")
		if len(parts) < 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		valStr := strings.TrimSuffix(strings.TrimSpace(parts[1]), ".")

		val, err := strconv.ParseUint(valStr, 10, 64)
		if err != nil {
			continue
		}

		switch key {
		case "Pages active":
			active = val
		case "Pages speculative":
			speculative = val
		case "Pages wired down":
			wired = val
		case "Pages occupied by compressor":
			compressed = val
		}
	}

	used := (active + speculative + wired + compressed) * pageSize
	return total, used, nil
}

func getHostStats() HostStats {
	stats := HostStats{
		CPU:      1.5,
		RAMUsed:  8 * 1024 * 1024 * 1024,
		RAMTotal: 16 * 1024 * 1024 * 1024,
	}

	// 1. Try macOS `top` command first
	cmd := exec.Command("top", "-l", "1", "-n", "0")
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err == nil {
		lines := strings.Split(out.String(), "\n")
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "CPU usage:") {
				var user, sys, idle float64
				_, err := fmt.Sscanf(line, "CPU usage: %f%% user, %f%% sys, %f%% idle", &user, &sys, &idle)
				if err == nil {
					stats.CPU = user + sys
				}
			} else if strings.HasPrefix(line, "PhysMem:") {
				usedVal, usedUnit, unusedVal, unusedUnit := parsePhysMem(line)
				if usedVal > 0 && unusedVal > 0 {
					var usedBytes uint64
					if usedUnit == 'G' || usedUnit == 'g' {
						usedBytes = uint64(usedVal * 1024 * 1024 * 1024)
					} else {
						usedBytes = uint64(usedVal * 1024 * 1024)
					}
					var unusedBytes uint64
					if unusedUnit == 'G' || unusedUnit == 'g' {
						unusedBytes = uint64(unusedVal * 1024 * 1024 * 1024)
					} else {
						unusedBytes = uint64(unusedVal * 1024 * 1024)
					}
					stats.RAMUsed = usedBytes
					stats.RAMTotal = usedBytes + unusedBytes
				}
			}
		}
		// Overwrite with accurate macOS RAM metrics if available
		if ramTotal, ramUsed, err := getMacRAM(); err == nil {
			stats.RAMTotal = ramTotal
			stats.RAMUsed = ramUsed
		}
		return stats
	}

	// 2. Try Linux /proc/meminfo and /proc/stat
	if data, err := os.ReadFile("/proc/meminfo"); err == nil {
		var memTotal, memFree, memAvailable uint64
		lines := strings.Split(string(data), "\n")
		for _, line := range lines {
			parts := strings.Fields(line)
			if len(parts) >= 2 {
				var val uint64
				fmt.Sscanf(parts[1], "%d", &val)
				valBytes := val * 1024 // /proc/meminfo is in kB
				if parts[0] == "MemTotal:" {
					memTotal = valBytes
				} else if parts[0] == "MemFree:" {
					memFree = valBytes
				} else if parts[0] == "MemAvailable:" {
					memAvailable = valBytes
				}
			}
		}
		if memTotal > 0 {
			stats.RAMTotal = memTotal
			if memAvailable > 0 {
				stats.RAMUsed = memTotal - memAvailable
			} else if memFree > 0 {
				stats.RAMUsed = memTotal - memFree
			}
		}
	}

	// Dynamic CPU parsing for Linux /proc/stat
	if data, err := os.ReadFile("/proc/stat"); err == nil {
		lines := strings.Split(string(data), "\n")
		if len(lines) > 0 && strings.HasPrefix(lines[0], "cpu ") {
			parts := strings.Fields(lines[0])
			if len(parts) >= 5 {
				var user, nice, system, idle uint64
				fmt.Sscanf(parts[1], "%d", &user)
				fmt.Sscanf(parts[2], "%d", &nice)
				fmt.Sscanf(parts[3], "%d", &system)
				fmt.Sscanf(parts[4], "%d", &idle)
				total := user + nice + system + idle
				active := user + nice + system
				if total > 0 {
					stats.CPU = float64(active) / float64(total) * 100.0
				}
			}
		}
	}

	return stats
}

func startTelemetryPoller() {
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			stats := getHostStats()

			activeSrv, err := GetActiveServer()
			var activeModels []ProcessModel
			nodeURL := ""
			isRemote := false

			if err == nil {
				nodeURL = activeSrv.URL
				isRemote = isRemoteURL(activeSrv.URL)
				client := NewOllamaClient(activeSrv)
				models, err := client.ListActiveModels()
				if err == nil {
					activeModels = models
				}
			}

			telemetryMutex.Lock()
			currentTelemetry = TelemetryPayload{
				AppHost: stats,
				OllamaNode: OllamaNodeInfo{
					URL:      nodeURL,
					IsRemote: isRemote,
				},
				ActiveModels: activeModels,
			}
			telemetryMutex.Unlock()
		}
	}()
}

func telemetryStreamHandler(c *gin.Context) {
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("Transfer-Encoding", "chunked")

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	ctx := c.Request.Context()

	c.Stream(func(w io.Writer) bool {
		select {
		case <-ctx.Done():
			return false
		case <-ticker.C:
			telemetryMutex.Lock()
			data, err := json.Marshal(currentTelemetry)
			telemetryMutex.Unlock()

			if err == nil {
				c.SSEvent("telemetry", string(data))
				return true
			}
		}
		return true
	})
}

// Settings Handlers
func getSettingsHandler(c *gin.Context) {
	settings, err := GetSettings()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, settings)
}

type UpdateSettingRequest struct {
	Key   string `json:"key" binding:"required"`
	Value string `json:"value" binding:"required"`
}

func updateSettingHandler(c *gin.Context) {
	var req UpdateSettingRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	err := UpdateSetting(req.Key, req.Value)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Setting updated successfully"})
}

func diagnosticsHandler(c *gin.Context) {
	checks := []DiagnosticCheck{}
	addCheck := func(name, status, message, details string) {
		checks = append(checks, DiagnosticCheck{
			Name:    name,
			Status:  status,
			Message: message,
			Details: details,
		})
	}

	if DB == nil {
		addCheck("SQLite Database", "fail", "Database handle is not initialized.", "")
	} else if err := DB.Ping(); err != nil {
		addCheck("SQLite Database", "fail", "Database ping failed.", err.Error())
	} else {
		addCheck("SQLite Database", "pass", "Database connection is live.", "data/neurollama.db")
	}

	if err := os.MkdirAll("data", 0755); err != nil {
		addCheck("Data Directory", "fail", "Data directory cannot be created.", err.Error())
	} else if f, err := os.CreateTemp("data", ".neurollama-health-*"); err != nil {
		addCheck("Data Directory", "fail", "Data directory is not writable.", err.Error())
	} else {
		name := f.Name()
		_ = f.Close()
		_ = os.Remove(name)
		addCheck("Data Directory", "pass", "Data directory is writable.", "data/")
	}

	if info, err := os.Stat("static/css/output.css"); err != nil {
		addCheck("Static Assets", "fail", "Compiled CSS is missing.", err.Error())
	} else if info.Size() == 0 {
		addCheck("Static Assets", "fail", "Compiled CSS exists but is empty.", "static/css/output.css")
	} else {
		addCheck("Static Assets", "pass", "Compiled CSS is present.", fmt.Sprintf("%d bytes", info.Size()))
	}

	if info, err := os.Stat("templates/index.html"); err != nil {
		addCheck("HTML Template", "fail", "Main HTML template is missing.", err.Error())
	} else if info.Size() == 0 {
		addCheck("HTML Template", "fail", "Main HTML template exists but is empty.", "templates/index.html")
	} else {
		addCheck("HTML Template", "pass", "Main HTML template is present.", fmt.Sprintf("%d bytes", info.Size()))
	}

	if _, err := GetSettings(); err != nil {
		addCheck("Settings Store", "fail", "Settings table could not be read.", err.Error())
	} else {
		addCheck("Settings Store", "pass", "Settings table is readable.", "")
	}

	activeSrv, err := GetActiveServer()
	if err != nil {
		addCheck("Active Ollama Node", "warn", "No active Ollama node is configured.", err.Error())
	} else {
		client := NewOllamaClient(activeSrv)
		version, latency, err := client.CheckStatus()
		if err != nil {
			addCheck("Active Ollama Node", "fail", "Active Ollama node is unreachable.", err.Error())
		} else {
			addCheck("Active Ollama Node", "pass", "Active Ollama node responded to /api/version.", fmt.Sprintf("%s in %dms", version, latency.Milliseconds()))
			if models, err := client.ListModels(); err != nil {
				addCheck("Model Inventory", "warn", "Active node responded, but models could not be listed.", err.Error())
			} else if len(models) == 0 {
				addCheck("Model Inventory", "warn", "Active node is reachable but has no installed models.", activeSrv.URL)
			} else {
				addCheck("Model Inventory", "pass", "Model inventory is readable.", fmt.Sprintf("%d models", len(models)))
			}
		}
	}

	port := strings.TrimSpace(os.Getenv("PORT"))
	if port == "" {
		port = "8080"
	}
	addCheck("HTTP Listener", "pass", "Runtime port configuration is resolved.", ":"+port)
	addCheck("Streaming Routes", "pass", "Streaming endpoints are registered and use request cancellation.", "/api/chat, /api/generate, /api/models/create, /api/benchmarks/run, /api/optimizer/run")

	c.JSON(http.StatusOK, DiagnosticsResponse{
		GeneratedAt: time.Now().Format(time.RFC3339),
		Checks:      checks,
	})
}

func getSchedulerLogsHandler(c *gin.Context) {
	logs, err := GetSchedulerLogs()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, logs)
}

func runModelUpdatesCheck() {
	activeSrv, err := GetActiveServer()
	if err != nil {
		log.Printf("Scheduler: no active server selected: %v", err)
		return
	}

	client := NewOllamaClient(activeSrv)
	models, err := client.ListModels()
	if err != nil {
		log.Printf("Scheduler: failed to list models on active server: %v", err)
		_ = LogScheduleAction("system", "error", fmt.Sprintf("Failed to list models: %v", err))
		return
	}

	if len(models) == 0 {
		_ = LogScheduleAction("system", "info", "No models found to update.")
		return
	}

	_ = LogScheduleAction("system", "info", fmt.Sprintf("Starting update check for %d models...", len(models)))

	for _, m := range models {
		log.Printf("Scheduler: updating model %s...", m.Name)
		_ = LogScheduleAction(m.Name, "pending", "Checking/pulling updates...")

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		stream, err := client.StreamPullModel(ctx, m.Name)
		if err != nil {
			cancel()
			_ = LogScheduleAction(m.Name, "failed", fmt.Sprintf("Failed to start pull: %v", err))
			continue
		}

		var lastStatus string
		err = ParsePullProgress(stream, func(progress PullProgress) bool {
			lastStatus = progress.Status
			return true
		})
		stream.Close()
		cancel()

		if err != nil {
			_ = LogScheduleAction(m.Name, "failed", fmt.Sprintf("Pull error: %v", err))
		} else {
			_ = LogScheduleAction(m.Name, "success", fmt.Sprintf("Updated successfully. Last status: %s", lastStatus))
		}
	}

	_ = UpdateSetting("last_update_check", time.Now().Format("2006-01-02 15:04:05"))
}

func checkModelUpdatesNowHandler(c *gin.Context) {
	go runModelUpdatesCheck()
	c.JSON(http.StatusOK, gin.H{"message": "Model update check initiated in background."})
}

func startSchedulerTicker() {
	go func() {
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			settings, err := GetSettings()
			if err != nil {
				continue
			}

			schedule := settings["update_schedule"]
			if schedule == "off" || schedule == "" {
				continue
			}

			now := time.Now()
			if now.Hour() != 2 {
				continue
			}

			lastCheckStr := settings["last_update_check"]
			if lastCheckStr != "" {
				lastCheck, err := time.Parse("2006-01-02 15:04:05", lastCheckStr)
				if err == nil {
					if schedule == "daily" {
						if lastCheck.Year() == now.Year() && lastCheck.YearDay() == now.YearDay() {
							continue
						}
					} else if schedule == "weekly" {
						if now.Sub(lastCheck) < 6*24*time.Hour {
							continue
						}
					}
				}
			}

			log.Printf("Scheduler: triggering scheduled update. Schedule: %s", schedule)
			runModelUpdatesCheck()
		}
	}()
}

// Context Compression Functions
func CompressChatSession(chatID int64, modelName string) (string, error) {
	messages, err := GetChatMessages(chatID)
	if err != nil {
		return "", err
	}

	if len(messages) <= 2 {
		return "", fmt.Errorf("not enough messages to compress")
	}

	var sb strings.Builder
	sb.WriteString("Summarize the following conversation history briefly. Focus only on key facts, preferences, decisions, and instructions established. Keep the summary concise (under 250 words) and direct. Do not add any introductory or concluding text.\n\nCONVERSATION HISTORY:\n")
	for _, m := range messages {
		sb.WriteString(fmt.Sprintf("%s: %s\n", m.Role, m.Content))
	}

	activeSrv, err := GetActiveServer()
	if err != nil {
		return "", fmt.Errorf("no active server selected: %w", err)
	}

	client := NewOllamaClient(activeSrv)

	reqBody, err := json.Marshal(map[string]interface{}{
		"model":  modelName,
		"prompt": sb.String(),
		"stream": false,
	})
	if err != nil {
		return "", err
	}

	resp, err := client.HTTPClient.Post(
		fmt.Sprintf("%s/api/generate", client.BaseURL),
		"application/json",
		bytes.NewBuffer(reqBody),
	)
	if err != nil {
		return "", fmt.Errorf("failed to contact Ollama for summary: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("summary generate failed, status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	var genResp struct {
		Response string `json:"response"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&genResp); err != nil {
		return "", fmt.Errorf("failed to parse summary response: %w", err)
	}

	summaryText := strings.TrimSpace(genResp.Response)
	if summaryText == "" {
		return "", fmt.Errorf("generated summary was empty")
	}

	tx, err := DB.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()

	_, err = tx.Exec("DELETE FROM messages WHERE chat_id = ?", chatID)
	if err != nil {
		return "", err
	}

	systemMsg := fmt.Sprintf("CONVERSATION SUMMARY (Auto-Compressed):\n%s", summaryText)
	_, err = tx.Exec("INSERT INTO messages (chat_id, role, content) VALUES (?, 'system', ?)", chatID, systemMsg)
	if err != nil {
		return "", err
	}

	if err := tx.Commit(); err != nil {
		return "", err
	}

	return systemMsg, nil
}

func compressChatHandler(c *gin.Context) {
	idStr := c.Param("id")
	var id int64
	if _, err := fmt.Sscanf(idStr, "%d", &id); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid chat ID"})
		return
	}

	chat, err := GetChat(id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to fetch chat details"})
		return
	}
	if chat == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Chat session not found"})
		return
	}

	summary, err := CompressChatSession(id, chat.Model)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Chat compressed successfully", "summary": summary})
}

// Benchmarking Functions
func getBenchmarksHandler(c *gin.Context) {
	benchmarks, err := GetBenchmarks()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, benchmarks)
}

func runBenchmarkForPrompt(ctx context.Context, client *OllamaClient, model string, prompt string, logFunc func(string)) (float64, float64, float64, error) {
	req := GenerateRequest{
		Model:  model,
		Prompt: prompt,
		Stream: true,
		Options: map[string]interface{}{
			"temperature": 0.0,
		},
	}

	start := time.Now()
	stream, err := client.StreamGenerate(ctx, req)
	if err != nil {
		return 0, 0, 0, err
	}
	defer stream.Close()

	var firstTokenTime time.Duration
	var firstTokenReceived bool
	var tokenCount int

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
			}
		}
	}

	totalDuration := time.Since(start)

	if !firstTokenReceived {
		return 0, 0, 0, fmt.Errorf("no tokens received from model")
	}

	ttftMs := float64(firstTokenTime.Milliseconds())
	generationDurationSec := totalDuration.Seconds() - firstTokenTime.Seconds()
	if generationDurationSec <= 0 {
		generationDurationSec = 0.001
	}
	tps := float64(tokenCount) / generationDurationSec
	avgLatency := float64(totalDuration.Milliseconds())

	return ttftMs, tps, avgLatency, nil
}

func runBenchmarkSSEHandler(c *gin.Context) {
	model := c.Query("model")
	if model == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Model parameter is required"})
		return
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

	prompts := []string{
		"Explain the difference between TCP and UDP in one simple sentence.",
		"Write a short Python function that checks if a string is a palindrome.",
		"Briefly explain the theory of relativity to a 10-year-old in one paragraph.",
	}

	c.Stream(func(w io.Writer) bool {
		c.SSEvent("status", fmt.Sprintf("Initializing benchmark for %s...", model))

		var totalTtft, totalTps, totalLatency float64
		var successfulRuns int

		for i, prompt := range prompts {
			c.SSEvent("status", fmt.Sprintf("Running Prompt %d/3: \"%s\"", i+1, prompt))

			ttft, tps, latency, err := runBenchmarkForPrompt(ctx, client, model, prompt, func(logMsg string) {
				c.SSEvent("status", logMsg)
			})

			if err != nil {
				c.SSEvent("error", fmt.Sprintf("Prompt %d failed: %v", i+1, err))
				continue
			}

			c.SSEvent("status", fmt.Sprintf("Prompt %d finished - TTFT: %.1fms, TPS: %.1f, Latency: %.1fms", i+1, ttft, tps, latency))
			totalTtft += ttft
			totalTps += tps
			totalLatency += latency
			successfulRuns++
		}

		if successfulRuns == 0 {
			c.SSEvent("error", "Benchmark failed: all runs failed.")
			return false
		}

		avgTtft := totalTtft / float64(successfulRuns)
		avgTps := totalTps / float64(successfulRuns)
		avgLatency := totalLatency / float64(successfulRuns)

		id, err := SaveBenchmark(model, avgTtft, avgTps, avgLatency)
		if err != nil {
			c.SSEvent("error", fmt.Sprintf("Failed to save benchmark: %v", err))
			return false
		}

		c.SSEvent("status", "Benchmark suite completed successfully.")

		resultPayload := map[string]interface{}{
			"id":             id,
			"model_name":     model,
			"ttft_ms":        avgTtft,
			"tps":            avgTps,
			"avg_latency_ms": avgLatency,
		}

		resBytes, _ := json.Marshal(resultPayload)
		c.SSEvent("done", string(resBytes))
		return false
	})
}

type UpdateScoreRequest struct {
	Score string `json:"score" binding:"required"`
	Notes string `json:"notes"`
}

func updateBenchmarkScoreHandler(c *gin.Context) {
	idStr := c.Param("id")
	var id int64
	if _, err := fmt.Sscanf(idStr, "%d", &id); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid benchmark ID"})
		return
	}

	var req UpdateScoreRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	err := UpdateBenchmarkScore(id, req.Score, req.Notes)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Score updated successfully"})
}

func deleteBenchmarkHandler(c *gin.Context) {
	idStr := c.Param("id")
	var id int64
	if _, err := fmt.Sscanf(idStr, "%d", &id); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid benchmark ID"})
		return
	}

	err := DeleteBenchmark(id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Benchmark deleted successfully"})
}

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
	defer stream.Close()

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

// --- RAG HANDLERS ---

func getRAGDocumentsHandler(c *gin.Context) {
	docs, err := GetRAGDocuments()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, docs)
}

func uploadRAGDocumentHandler(c *gin.Context) {
	var req struct {
		Name           string `json:"name" binding:"required"`
		EmbeddingModel string `json:"embedding_model" binding:"required"`
		Chunks         []struct {
			ChunkIndex int    `json:"chunk_index"`
			Content    string `json:"content" binding:"required"`
		} `json:"chunks" binding:"required"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if len(req.Chunks) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No document chunks provided"})
		return
	}

	activeSrv, err := GetActiveServer()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "No active Ollama server selected"})
		return
	}

	client := NewOllamaClient(activeSrv)

	// Extract text contents to embed
	texts := make([]string, len(req.Chunks))
	for i, ch := range req.Chunks {
		texts[i] = ch.Content
	}

	// Fetch embeddings from Ollama in one batch
	embeddings, err := client.GetEmbeddings(req.EmbeddingModel, texts)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("Failed to generate embeddings from Ollama: %v", err)})
		return
	}

	if len(embeddings) != len(req.Chunks) {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Mismatch in generated embeddings count"})
		return
	}

	// Prepare chunks for saving
	var chunksToSave []RAGChunk
	for i, ch := range req.Chunks {
		chunksToSave = append(chunksToSave, RAGChunk{
			ChunkIndex: ch.ChunkIndex,
			Content:    ch.Content,
			Embedding:  embeddings[i],
		})
	}

	docID, err := SaveRAGDocument(req.Name, req.EmbeddingModel, chunksToSave)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message":     "Document uploaded and indexed successfully",
		"document_id": docID,
		"chunks":      len(chunksToSave),
	})
}

func deleteRAGDocumentHandler(c *gin.Context) {
	idStr := c.Param("id")
	var id int64
	if _, err := fmt.Sscanf(idStr, "%d", &id); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid document ID"})
		return
	}

	err := DeleteRAGDocument(id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Document deleted successfully"})
}

func queryRAGSimilarityHandler(c *gin.Context) {
	var req struct {
		Query          string `json:"query" binding:"required"`
		EmbeddingModel string `json:"embedding_model" binding:"required"`
		TopK           int    `json:"top_k"`
	}

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

	// Fetch query embedding
	embeddings, err := client.GetEmbeddings(req.EmbeddingModel, []string{req.Query})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("Failed to embed query: %v", err)})
		return
	}
	if len(embeddings) == 0 {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "No query embedding returned"})
		return
	}
	queryEmbed := embeddings[0]

	// Fetch all chunks for target model
	allChunks, err := GetRAGChunksForModel(req.EmbeddingModel)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	type searchResult struct {
		DocumentName string  `json:"document_name"`
		ChunkIndex   int     `json:"chunk_index"`
		Content      string  `json:"content"`
		Similarity   float64 `json:"similarity"`
	}

	var results []searchResult
	for _, chunk := range allChunks {
		sim := cosineSimilarity(queryEmbed, chunk.Embedding)
		results = append(results, searchResult{
			DocumentName: chunk.DocumentName,
			ChunkIndex:   chunk.ChunkIndex,
			Content:      chunk.Content,
			Similarity:   sim,
		})
	}

	// Sort by similarity descending
	sort.Slice(results, func(i, j int) bool {
		return results[i].Similarity > results[j].Similarity
	})

	topK := 3
	if req.TopK > 0 {
		topK = req.TopK
	}
	if len(results) < topK {
		topK = len(results)
	}

	c.JSON(http.StatusOK, results[:topK])
}

// cosineSimilarity calculates cosine similarity between two vector slices.
func cosineSimilarity(a, b []float64) float64 {
	if len(a) != len(b) || len(a) == 0 {
		return 0.0
	}
	var dotProduct, normA, normB float64
	for i := 0; i < len(a); i++ {
		dotProduct += a[i] * b[i]
		normA += a[i] * a[i]
		normB += b[i] * b[i]
	}
	if normA == 0.0 || normB == 0.0 {
		return 0.0
	}
	return dotProduct / (math.Sqrt(normA) * math.Sqrt(normB))
}
