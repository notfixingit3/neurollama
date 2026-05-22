package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
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
	Name string `json:"name" binding:"required"`
	URL  string `json:"url" binding:"required"`
}

type EditServerRequest struct {
	Name string `json:"name" binding:"required"`
	URL  string `json:"url" binding:"required"`
}

type BatchDeleteRequest struct {
	Names []string `json:"names" binding:"required"`
}

func main() {
	// Load config data
	if err := LoadConfig(); err != nil {
		log.Fatalf("Error loading config: %v", err)
	}

	// Initialize SQLite Database
	if err := InitDB("data/ollama-manager.db"); err != nil {
		log.Fatalf("Error initializing database: %v", err)
	}

	r := gin.Default()

	// Load HTML templates
	r.LoadHTMLGlob("templates/*")

	// Serve static files
	r.Static("/static", "./static")

	// HTML routes
	r.GET("/", func(c *gin.Context) {
		c.HTML(http.StatusOK, "index.html", gin.H{
			"title": "Ollama Manager 2026",
		})
	})

	// API routes
	api := r.Group("/api")
	{
		// Server endpoints
		api.GET("/servers", getServersHandler)
		api.POST("/servers", addServerHandler)
		api.PUT("/servers/:id", editServerHandler)
		api.DELETE("/servers/:id", deleteServerHandler)
		api.POST("/servers/:id/select", selectServerHandler)

		// Active Ollama client proxies
		api.GET("/models", getModelsHandler)
		api.GET("/models/detail", getModelDetailHandler) // GET /api/models/detail?name=llama3
		api.POST("/models/delete", deleteModelsHandler)  // POST batch delete
		api.POST("/models/copy", copyModelHandler)      // POST clone model
		api.GET("/models/pull", pullModelSSEHandler)    // GET /api/models/pull?name=llama3 (SSE)
		api.GET("/models/card", getModelCardHandler)    // GET /api/models/card?name=llama3

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
	}

	log.Println("Ollama Manager is starting on http://localhost:8080")
	if err := r.Run(":8080"); err != nil {
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
			client := NewOllamaClient(s.URL)
			version, latency, err := client.CheckStatus()

			status := "online"
			if err != nil {
				status = "offline"
				version = ""
				latency = 0
			}

			responses[idx] = ServerStatusResponse{
				Server:  s,
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

	newSrv, err := AddServer(req.Name, req.URL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Fetch status immediately to return complete record
	client := NewOllamaClient(newSrv.URL)
	version, latency, err := client.CheckStatus()
	status := "online"
	if err != nil {
		status = "offline"
		version = ""
		latency = 0
	}

	c.JSON(http.StatusCreated, ServerStatusResponse{
		Server:  newSrv,
		Status:  status,
		Version: version,
		Latency: latency.Milliseconds(),
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

	updatedSrv, err := EditServer(id, req.Name, req.URL)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	client := NewOllamaClient(updatedSrv.URL)
	version, latency, err := client.CheckStatus()
	status := "online"
	if err != nil {
		status = "offline"
		version = ""
		latency = 0
	}

	c.JSON(http.StatusOK, ServerStatusResponse{
		Server:  updatedSrv,
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

	client := NewOllamaClient(srv.URL)
	version, latency, err := client.CheckStatus()
	status := "online"
	if err != nil {
		status = "offline"
		version = ""
		latency = 0
	}

	c.JSON(http.StatusOK, ServerStatusResponse{
		Server:  srv,
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

	client := NewOllamaClient(activeSrv.URL)
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

	client := NewOllamaClient(activeSrv.URL)
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

	client := NewOllamaClient(activeSrv.URL)
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

	client := NewOllamaClient(activeSrv.URL)
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

	client := NewOllamaClient(activeSrv.URL)
	stream, err := client.StreamPullModel(name)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer stream.Close()

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

	client := NewOllamaClient(activeSrv.URL)
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

	client := NewOllamaClient(activeSrv.URL)
	if err := client.UnloadModel(req.Name); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Model unloaded successfully"})
}

type ChatStreamRequest struct {
	Model            string        `json:"model" binding:"required"`
	Messages         []ChatMessage `json:"messages" binding:"required"`
	Temperature      *float64      `json:"temperature"`
	NumCtx           int           `json:"num_ctx"`
	ChatID           *int64        `json:"chat_id"`
	TopK             *int          `json:"top_k"`
	TopP             *float64      `json:"top_p"`
	RepeatPenalty    *float64      `json:"repeat_penalty"`
	Seed             *int          `json:"seed"`
	MinP             *float64      `json:"min_p"`
	PresencePenalty  *float64      `json:"presence_penalty"`
	FrequencyPenalty *float64      `json:"frequency_penalty"`
	NumPredict       *int          `json:"num_predict"`
	NumGPU           *int          `json:"num_gpu"`
	NumThread        *int          `json:"num_thread"`
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

	client := NewOllamaClient(activeSrv.URL)

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

	stream, err := client.StreamChat(chatReq)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer stream.Close()

	// Write user message to DB if chat session is active
	if req.ChatID != nil && *req.ChatID > 0 && len(req.Messages) > 0 {
		lastMsg := req.Messages[len(req.Messages)-1]
		if err := SaveChatMessage(*req.ChatID, lastMsg.Role, lastMsg.Content, lastMsg.Images); err != nil {
			log.Printf("Error saving user prompt to db: %v", err)
		}
	}

	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("Transfer-Encoding", "chunked")

	var accumulatedContent string

	c.Stream(func(w io.Writer) bool {
		scanner := bufio.NewScanner(stream)
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

	client := NewOllamaClient(activeSrv.URL)

	createReq := CreateRequest{
		Name:      req.Name,
		Modelfile: req.Modelfile,
		Stream:    true,
	}

	stream, err := client.StreamCreate(createReq)
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
		scanner := bufio.NewScanner(stream)
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

	client := NewOllamaClient(activeSrv.URL)

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

	stream, err := client.StreamGenerate(genReq)
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
		scanner := bufio.NewScanner(stream)
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

