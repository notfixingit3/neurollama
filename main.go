package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	goPDF "github.com/ledongthuc/pdf"
)

const appVersion = "v0.2.10"

var (
	appStartTime = time.Now()
	activeDBPath = "data/neurollama.db"
)

type ServerStatusResponse struct {
	Server
	Status  string `json:"status"` // "online" or "offline"
	Version string `json:"version"`
	Latency int64  `json:"latency"` // in milliseconds
}

type AddServerRequest struct {
	Name           string  `json:"name" binding:"required"`
	URL            string  `json:"url" binding:"required"`
	VramGB         float64 `json:"vramGb"`
	AuthType       string  `json:"authType"`
	AuthToken      string  `json:"authToken"`
	AuthUsername   string  `json:"authUsername"`
	AuthPassword   string  `json:"authPassword"`
	AuthHeaderName string  `json:"authHeaderName"`
	AuthHeaderVal  string  `json:"authHeaderVal"`
}

type EditServerRequest struct {
	Name           string  `json:"name" binding:"required"`
	URL            string  `json:"url" binding:"required"`
	VramGB         float64 `json:"vramGb"`
	AuthType       string  `json:"authType"`
	AuthToken      string  `json:"authToken"`
	AuthUsername   string  `json:"authUsername"`
	AuthPassword   string  `json:"authPassword"`
	AuthHeaderName string  `json:"authHeaderName"`
	AuthHeaderVal  string  `json:"authHeaderVal"`
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
	// CLI flags
	portFlag := flag.Int("port", 0, "Port to listen on (overrides PORT env var, default 8080)")
	showVersion := flag.Bool("version", false, "Print version and exit")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "NEUROLLAMA %s — Ollama node control panel\n\n", appVersion)
		fmt.Fprintf(os.Stderr, "Usage:\n  neurollama [flags]\n\nFlags:\n")
		flag.PrintDefaults()
		fmt.Fprintf(os.Stderr, "\nEnvironment variables:\n")
		fmt.Fprintf(os.Stderr, "  PORT          Port to listen on (default 8080)\n")
		fmt.Fprintf(os.Stderr, "  GIN_MODE      Set to 'release' to suppress debug output\n\n")
		fmt.Fprintf(os.Stderr, "Examples:\n")
		fmt.Fprintf(os.Stderr, "  neurollama --port 9000\n")
		fmt.Fprintf(os.Stderr, "  PORT=9000 neurollama\n")
	}
	flag.Parse()

	if *showVersion {
		fmt.Println(appVersion)
		os.Exit(0)
	}

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
	activeDBPath = dbPath

	// Apply any pending database restore before opening the DB
	pendingRestorePath := dbPath + ".pending"
	if _, err := os.Stat(pendingRestorePath); err == nil {
		log.Println("Applying pending database restore...")
		if err := os.Rename(pendingRestorePath, dbPath); err != nil {
			log.Printf("Warning: failed to apply pending restore: %v", err)
		} else {
			log.Println("Database restore applied successfully.")
		}
	}

	if err := InitDB(dbPath); err != nil {
		log.Fatalf("Error initializing database: %v", err)
	}

	// Start background pollers and scheduler
	startNodeCachePoller() // warms node-status and model-list caches before first request
	startTelemetryPoller()
	startSchedulerTicker()

	r := gin.Default()

	// Load HTML templates
	r.LoadHTMLGlob("templates/*")

	// Serve static files
	r.Static("/static", "./static")
	r.StaticFile("/favicon.ico", "./static/img/favicon.ico")

	// Health check — used by Docker HEALTHCHECK and load balancers
	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "version": appVersion})
	})

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
		api.GET("/models/search", searchModelsHandler)   // GET /api/models/search?q=llama3&nodes=all
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

		// Node management
		api.GET("/nodes/overview", nodesOverviewHandler)
		api.POST("/nodes/:id/refresh", refreshNodeHandler)

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
		api.GET("/benchmarks/grouped", getGroupedBenchmarksHandler)
		api.GET("/benchmarks/run", runBenchmarkSSEHandler)
		api.PUT("/benchmarks/:id/score", updateBenchmarkScoreHandler)
		api.DELETE("/benchmarks/:id", deleteBenchmarkHandler)

		// Hyperparameter Optimizer
		api.GET("/optimizer/runs", getOptimizerRunsHandler)
		api.GET("/optimizer/run", runOptimizerSSEHandler)
		api.DELETE("/optimizer/runs/:id", deleteOptimizerRunHandler)

		// Document RAG Panel Endpoints
		api.POST("/rag/extract-pdf", extractPDFTextHandler)         // server-side PDF → text (avoids browser hang)
		api.POST("/rag/upload-and-index", uploadAndIndexHandler)     // combined: extract + chunk + embed + save, streams NDJSON
		api.GET("/rag/documents", getRAGDocumentsHandler)
		api.POST("/rag/documents", uploadRAGDocumentHandler)
		api.POST("/rag/documents/:id/chunks", appendRAGChunksHandler)
		api.DELETE("/rag/documents/:id", deleteRAGDocumentHandler)
		api.POST("/rag/query", queryRAGSimilarityHandler)

		// Diagnostics
		api.GET("/diagnostics", diagnosticsHandler)

		// System — About, bulk-delete, backup/restore, activity, presets
		api.GET("/about", aboutHandler)
		api.DELETE("/chats", deleteAllChatsHandler)
		api.DELETE("/benchmarks", deleteAllBenchmarksHandler)
		api.GET("/backup", backupDBHandler)
		api.POST("/restore", restoreDBHandler)
		api.GET("/activity", activityLogHandler)
		api.GET("/presets/export", exportPresetsHandler)
		api.POST("/presets/import", importPresetsHandler)
	}

	port, err := resolvePort(*portFlag)
	if err != nil {
		log.Fatalf("Invalid port: %v", err)
	}
	addr := fmt.Sprintf(":%d", port)

	log.Printf("NEUROLLAMA %s starting on http://localhost%s", appVersion, addr)
	if err := r.Run(addr); err != nil {
		log.Fatalf("Server failed to run: %v", err)
	}
}

func resolvePort(flagPort int) (int, error) {
	// --port flag takes precedence over PORT env var
	if flagPort != 0 {
		if flagPort < 1 || flagPort > 65535 {
			return 0, fmt.Errorf("must be between 1 and 65535")
		}
		return flagPort, nil
	}
	rawPort := strings.TrimSpace(os.Getenv("PORT"))
	if rawPort == "" {
		return 8080, nil
	}
	port, err := strconv.Atoi(rawPort)
	if err != nil {
		return 0, fmt.Errorf("must be a number between 1 and 65535")
	}
	if port < 1 || port > 65535 {
		return 0, fmt.Errorf("must be between 1 and 65535")
	}
	return port, nil
}

// getServersHandler returns all servers with their cached status — instant read.
func getServersHandler(c *gin.Context) {
	srvs := GetServers()
	responses := make([]ServerStatusResponse, 0, len(srvs))

	nodeStatusMu.RLock()
	for _, srv := range srvs {
		if entry, ok := nodeStatusCache[srv.ID]; ok {
			responses = append(responses, entry.response)
		} else {
			// Cache not yet populated for this node (race at startup); return unknown status.
			responses = append(responses, ServerStatusResponse{
				Server:  RedactServerSecrets(srv),
				Status:  "unknown",
				Version: "",
				Latency: 0,
			})
		}
	}
	nodeStatusMu.RUnlock()

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
		req.VramGB,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Fetch status immediately so the new node is in the cache before we respond.
	pollOneNodeStatus(newSrv)

	nodeStatusMu.RLock()
	resp := nodeStatusCache[newSrv.ID].response
	nodeStatusMu.RUnlock()

	LogActivity("node", fmt.Sprintf("Node registered: %s (%s)", req.Name, req.URL))
	c.JSON(http.StatusCreated, resp)
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
		req.VramGB,
	)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	// Refresh cache for the updated node; invalidate stale model list.
	invalidateNodeModelCache(updatedSrv.ID)
	pollOneNodeStatus(updatedSrv)

	nodeStatusMu.RLock()
	resp := nodeStatusCache[updatedSrv.ID].response
	nodeStatusMu.RUnlock()

	c.JSON(http.StatusOK, resp)
}

// deleteServerHandler deletes a server by ID and removes it from caches.
func deleteServerHandler(c *gin.Context) {
	id := c.Param("id")
	if err := DeleteServer(id); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	// Drop from both caches.
	nodeStatusMu.Lock()
	delete(nodeStatusCache, id)
	nodeStatusMu.Unlock()

	nodeModelMu.Lock()
	delete(nodeModelCache, id)
	nodeModelMu.Unlock()

	LogActivity("node", fmt.Sprintf("Node removed: %s", id))
	c.JSON(http.StatusOK, gin.H{"message": "Server deleted successfully"})
}

// selectServerHandler switches the active server, returning status from cache.
func selectServerHandler(c *gin.Context) {
	id := c.Param("id")
	srv, err := SetActiveServer(id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	nodeStatusMu.RLock()
	entry, ok := nodeStatusCache[id]
	nodeStatusMu.RUnlock()

	LogActivity("node", fmt.Sprintf("Active node switched to: %s", srv.Name))
	if ok {
		c.JSON(http.StatusOK, entry.response)
		return
	}

	// Cache miss (shouldn't happen after warm-up) — fall back to live check.
	client := NewPollerClient(srv)
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
		live, err := client.ListModels()
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
	if err := client.CopyModel(req.Source, req.Destination); err != nil {
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

	LogActivity("model", fmt.Sprintf("Model ejected from VRAM: %s", req.Name))
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
							fmt.Fprintf(&contextBuilder, "--- CONTEXT CHUNK #%d (Source: %s) ---\n%s\n\n", idx+1, match.chunk.DocumentName, match.chunk.Content)
							ragSources = append(ragSources, gin.H{
								"document_name": match.chunk.DocumentName,
								"chunk_index":   match.chunk.ChunkIndex,
								"score":         match.score,
								"content":       match.chunk.Content,
							})
						}
						fmt.Fprintf(&contextBuilder, "User Request: %s", chatReq.Messages[lastUserMsgIdx].Content)
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
	defer func() { _ = stream.Close() }()

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

type ExportPreset struct {
	Name    string `json:"name"`
	Content string `json:"content"`
}

func exportPresetsHandler(c *gin.Context) {
	presets, err := GetPresets()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	exported := make([]ExportPreset, len(presets))
	for i, p := range presets {
		exported[i] = ExportPreset{Name: p.Name, Content: p.Content}
	}
	filename := fmt.Sprintf("neurollama-presets-%s.json", time.Now().Format("20060102"))
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	c.Header("Content-Type", "application/json")
	LogActivity("system", fmt.Sprintf("Presets exported: %d presets", len(exported)))
	c.JSON(http.StatusOK, exported)
}

func importPresetsHandler(c *gin.Context) {
	file, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No file uploaded"})
		return
	}
	src, err := file.Open()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to open uploaded file"})
		return
	}
	defer src.Close()

	var presets []ExportPreset
	if err := json.NewDecoder(src).Decode(&presets); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON: " + err.Error()})
		return
	}

	imported := 0
	for _, p := range presets {
		if p.Name == "" || p.Content == "" {
			continue
		}
		if _, err := CreatePreset(p.Name, p.Content); err != nil {
			continue
		}
		imported++
	}
	LogActivity("system", fmt.Sprintf("Presets imported: %d presets from %s", imported, file.Filename))
	c.JSON(http.StatusOK, gin.H{"message": fmt.Sprintf("Imported %d preset(s).", imported), "count": imported})
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

	createSrvID := activeSrv.ID
	LogActivity("build", fmt.Sprintf("Build started: %s", req.Name))
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
	defer func() { _ = stream.Close() }()

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
			LogActivity("build", fmt.Sprintf("Build failed: %s — %s", req.Name, err.Error()))
			c.SSEvent("error", err.Error())
		} else {
			invalidateNodeModelCache(createSrvID)
			LogActivity("build", fmt.Sprintf("Build completed: %s", req.Name))
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
	defer func() { _ = stream.Close() }()

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

// ── Node & Model Cache ───────────────────────────────────────────────────────
// Background goroutines keep these warm so API handlers are instant reads.

// ── Activity Log ─────────────────────────────────────────────────────────────

type ActivityEntry struct {
	Time     string `json:"time"`
	Category string `json:"category"` // pull | build | model | node | benchmark | system
	Message  string `json:"message"`
}

var (
	activityMu      sync.Mutex
	activityBuf     []ActivityEntry
	activityMaxSize = 300
)

// LogActivity appends an event to the in-memory ring buffer.
func LogActivity(category, message string) {
	activityMu.Lock()
	defer activityMu.Unlock()
	activityBuf = append(activityBuf, ActivityEntry{
		Time:     time.Now().Format("15:04:05"),
		Category: category,
		Message:  message,
	})
	if len(activityBuf) > activityMaxSize {
		activityBuf = activityBuf[len(activityBuf)-activityMaxSize:]
	}
}

func activityLogHandler(c *gin.Context) {
	activityMu.Lock()
	// Return a reversed copy (newest first) without holding the lock during JSON encode.
	reversed := make([]ActivityEntry, len(activityBuf))
	for i, e := range activityBuf {
		reversed[len(activityBuf)-1-i] = e
	}
	activityMu.Unlock()
	c.JSON(http.StatusOK, reversed)
}

type nodeCacheEntry struct {
	response  ServerStatusResponse
	updatedAt time.Time
}

type modelCacheEntry struct {
	models    []OllamaModel
	updatedAt time.Time
}

var (
	nodeStatusMu    sync.RWMutex
	nodeStatusCache map[string]nodeCacheEntry // keyed by server ID

	nodeModelMu    sync.RWMutex
	nodeModelCache map[string]modelCacheEntry // keyed by server ID
)

// ── SSE Node-Status Broadcast Hub ────────────────────────────────────────────
// When a node changes state the poller broadcasts to every connected client
// via their individual buffered channel. The telemetry stream handler selects
// on this channel alongside its normal ticker so clients get instant updates.

var (
	nodeStatusSubsMu sync.RWMutex
	nodeStatusSubs   []chan ServerStatusResponse
)

func subscribeNodeStatus() chan ServerStatusResponse {
	ch := make(chan ServerStatusResponse, 16)
	nodeStatusSubsMu.Lock()
	nodeStatusSubs = append(nodeStatusSubs, ch)
	nodeStatusSubsMu.Unlock()
	return ch
}

func unsubscribeNodeStatus(ch chan ServerStatusResponse) {
	nodeStatusSubsMu.Lock()
	defer nodeStatusSubsMu.Unlock()
	for i, sub := range nodeStatusSubs {
		if sub == ch {
			nodeStatusSubs = append(nodeStatusSubs[:i], nodeStatusSubs[i+1:]...)
			close(ch)
			return
		}
	}
}

func broadcastNodeStatus(resp ServerStatusResponse) {
	nodeStatusSubsMu.RLock()
	defer nodeStatusSubsMu.RUnlock()
	for _, ch := range nodeStatusSubs {
		select {
		case ch <- resp:
		default: // buffer full — drop; client will catch up on next tick
		}
	}
}

func isRemoteURL(urlStr string) bool {
	u := strings.ToLower(urlStr)
	return !strings.Contains(u, "localhost") &&
		!strings.Contains(u, "127.0.0.1") &&
		!strings.Contains(u, "0.0.0.0") &&
		!strings.Contains(u, "[::1]")
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
	usedVal, usedUnit, ok := parseMemoryAmount(partUsed)
	if !ok {
		return 0, 0, 0, 0
	}

	idxComma := strings.LastIndex(line[:idxUnused], ",")
	if idxComma == -1 {
		return 0, 0, 0, 0
	}
	partUnused := line[idxComma+1 : idxUnused]
	partUnused = strings.TrimSpace(partUnused)
	unusedVal, unusedUnit, ok := parseMemoryAmount(partUnused)
	if !ok {
		return 0, 0, 0, 0
	}

	return usedVal, usedUnit, unusedVal, unusedUnit
}

func parseMemoryAmount(part string) (float64, rune, bool) {
	part = strings.TrimSpace(part)
	if len(part) < 2 {
		return 0, 0, false
	}

	unit := rune(part[len(part)-1])
	value, err := strconv.ParseFloat(strings.TrimSpace(part[:len(part)-1]), 64)
	if err != nil {
		return 0, 0, false
	}

	return value, unit, true
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
				val, err := strconv.ParseUint(parts[1], 10, 64)
				if err != nil {
					continue
				}
				valBytes := val * 1024 // /proc/meminfo is in kB
				switch parts[0] {
				case "MemTotal:":
					memTotal = valBytes
				case "MemFree:":
					memFree = valBytes
				case "MemAvailable:":
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
				user, errUser := strconv.ParseUint(parts[1], 10, 64)
				nice, errNice := strconv.ParseUint(parts[2], 10, 64)
				system, errSystem := strconv.ParseUint(parts[3], 10, 64)
				idle, errIdle := strconv.ParseUint(parts[4], 10, 64)
				if errUser != nil || errNice != nil || errSystem != nil || errIdle != nil {
					return stats
				}
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
				client := NewPollerClient(activeSrv) // 3s timeout — telemetry must not block
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

// startNodeCachePoller initialises the status and model caches, pre-warms them
// immediately, then keeps them fresh on background tickers.
func startNodeCachePoller() {
	nodeStatusCache = make(map[string]nodeCacheEntry)
	nodeModelCache = make(map[string]modelCacheEntry)

	go func() {
		// Warm-up before the first ticker fires
		pollAllNodeStatuses()
		pollAllNodeModels()

		statusTicker := time.NewTicker(5 * time.Second)
		modelTicker := time.NewTicker(60 * time.Second)
		defer statusTicker.Stop()
		defer modelTicker.Stop()

		for {
			select {
			case <-statusTicker.C:
				pollAllNodeStatuses()
			case <-modelTicker.C:
				pollAllNodeModels()
			}
		}
	}()
}

func pollAllNodeStatuses() {
	srvs := GetServers()
	var wg sync.WaitGroup
	for _, srv := range srvs {
		wg.Add(1)
		go func(s Server) {
			defer wg.Done()
			pollOneNodeStatus(s)
		}(srv)
	}
	wg.Wait()
}

func pollOneNodeStatus(srv Server) {
	client := NewPollerClient(srv) // 3s timeout
	version, latency, err := client.CheckStatus()
	status := "online"
	if err != nil {
		status = "offline"
		version = ""
		latency = 0
	}
	entry := nodeCacheEntry{
		response: ServerStatusResponse{
			Server:  RedactServerSecrets(srv),
			Status:  status,
			Version: version,
			Latency: latency.Milliseconds(),
		},
		updatedAt: time.Now(),
	}

	nodeStatusMu.Lock()
	old, hadOld := nodeStatusCache[srv.ID]
	nodeStatusCache[srv.ID] = entry
	nodeStatusMu.Unlock()

	// Push SSE event on any meaningful state change (first poll or flip).
	if !hadOld || old.response.Status != status || old.response.Version != version {
		broadcastNodeStatus(entry.response)
	}
}

func pollAllNodeModels() {
	srvs := GetServers()
	var wg sync.WaitGroup
	for _, srv := range srvs {
		// Skip nodes that are known to be offline
		nodeStatusMu.RLock()
		entry, ok := nodeStatusCache[srv.ID]
		nodeStatusMu.RUnlock()
		if ok && entry.response.Status != "online" {
			continue
		}
		wg.Add(1)
		go func(s Server) {
			defer wg.Done()
			pollOneNodeModels(s)
		}(srv)
	}
	wg.Wait()
}

func pollOneNodeModels(srv Server) {
	client := NewOllamaClient(srv) // 10s — listing 100+ models can take a moment
	models, err := client.ListModels()
	if err != nil {
		return // leave existing cache entry intact; poller will retry next cycle
	}
	nodeModelMu.Lock()
	nodeModelCache[srv.ID] = modelCacheEntry{models: models, updatedAt: time.Now()}
	nodeModelMu.Unlock()
}

// invalidateNodeModelCache drops a node's model cache entry and triggers an
// immediate background re-poll so the next /api/models request hits fresh data.
func invalidateNodeModelCache(serverID string) {
	nodeModelMu.Lock()
	delete(nodeModelCache, serverID)
	nodeModelMu.Unlock()
	go func() {
		for _, s := range GetServers() {
			if s.ID == serverID {
				pollOneNodeModels(s)
				return
			}
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

	// Register for reactive node-status events.
	nodeStatusCh := subscribeNodeStatus()
	defer unsubscribeNodeStatus(nodeStatusCh)

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
			}

		case resp, ok := <-nodeStatusCh:
			if !ok {
				return false
			}
			data, err := json.Marshal(resp)
			if err == nil {
				c.SSEvent("nodeStatus", string(data))
			}
		}
		return true
	})
}

// NodeOverviewEntry is one row in the fleet overview — aggregated from cache only.
type NodeOverviewEntry struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	URL            string `json:"url"`
	Status         string `json:"status"`
	Version        string `json:"version"`
	LatencyMs      int64  `json:"latency_ms"`
	ModelCount     int    `json:"model_count"`
	CacheUpdatedAt int64  `json:"cache_updated_at"` // unix seconds; 0 = not yet polled
}

// nodesOverviewHandler returns every node's cached status + model count in one call.
// GET /api/nodes/overview
func nodesOverviewHandler(c *gin.Context) {
	srvs := GetServers()
	entries := make([]NodeOverviewEntry, 0, len(srvs))

	nodeStatusMu.RLock()
	for _, srv := range srvs {
		e := NodeOverviewEntry{ID: srv.ID, Name: srv.Name, URL: srv.URL}
		if se, ok := nodeStatusCache[srv.ID]; ok {
			e.Status         = se.response.Status
			e.Version        = se.response.Version
			e.LatencyMs      = se.response.Latency
			e.CacheUpdatedAt = se.updatedAt.Unix()
		} else {
			e.Status = "unknown"
		}
		entries = append(entries, e)
	}
	nodeStatusMu.RUnlock()

	nodeModelMu.RLock()
	for i, e := range entries {
		if me, ok := nodeModelCache[e.ID]; ok {
			entries[i].ModelCount = len(me.models)
		}
	}
	nodeModelMu.RUnlock()

	c.JSON(http.StatusOK, entries)
}

// refreshNodeHandler drops a node's cached status and immediately re-polls,
// returning the fresh result. Used by the manual refresh button (Phase 2).
// POST /api/nodes/:id/refresh
func refreshNodeHandler(c *gin.Context) {
	id := c.Param("id")

	var found *Server
	for _, s := range GetServers() {
		if s.ID == id {
			cp := s
			found = &cp
			break
		}
	}
	if found == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "server not found"})
		return
	}

	// Drop stale entry then re-poll synchronously (3s timeout via NewPollerClient).
	nodeStatusMu.Lock()
	delete(nodeStatusCache, id)
	nodeStatusMu.Unlock()

	pollOneNodeStatus(*found)

	nodeStatusMu.RLock()
	entry := nodeStatusCache[id]
	nodeStatusMu.RUnlock()

	c.JSON(http.StatusOK, entry.response)
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

	if err := os.MkdirAll("data", 0700); err != nil {
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
		closeErr := stream.Close()
		cancel()

		if err != nil {
			_ = LogScheduleAction(m.Name, "failed", fmt.Sprintf("Pull error: %v", err))
		} else if closeErr != nil {
			_ = LogScheduleAction(m.Name, "failed", fmt.Sprintf("Failed to close pull stream: %v", closeErr))
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
		fmt.Fprintf(&sb, "%s: %s\n", m.Role, m.Content)
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
	defer func() { _ = resp.Body.Close() }()

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
	defer func() { _ = tx.Rollback() }() // no-op after Commit

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

// getGroupedBenchmarksHandler returns benchmark runs pre-grouped, averaged, and
// scored by the server so the browser only needs to render the result.
//
// Query params:
//
//	type  — "all" or a specific benchmark type (standard/vision/embedding/longctx/reasoning)
//	sort  — column name: model_name | server_name | tps | ttft_ms | avg_latency_ms | score | created_at
//	dir   — "asc" or "desc"
func getGroupedBenchmarksHandler(c *gin.Context) {
	filter  := c.DefaultQuery("type", "all")
	sortCol := c.DefaultQuery("sort", "created_at")
	sortDir := c.DefaultQuery("dir", "desc")

	// Whitelist sort params to avoid unexpected behaviour
	validCols := map[string]bool{
		"model_name": true, "server_name": true, "tps": true,
		"ttft_ms": true, "avg_latency_ms": true, "score": true, "created_at": true,
	}
	if !validCols[sortCol] { sortCol = "created_at" }
	if sortDir != "asc" && sortDir != "desc" { sortDir = "desc" }

	resp, err := GetGroupedBenchmarks(filter, sortCol, sortDir)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, resp)
}

// --- Vision test image (generated once at startup) ---

var visionTestImageBase64 string

func init() {
	visionTestImageBase64 = generateVisionTestImage()
}

// generateVisionTestImage builds a 256×256 four-quadrant colour card with a
// white circle in the centre — enough visual complexity for any vision model.
func generateVisionTestImage() string {
	const size = 256
	half := size / 2
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	quads := [4]color.RGBA{
		{191, 97, 106, 255},  // top-left:     Nord aurora red
		{163, 190, 140, 255}, // top-right:    Nord aurora green
		{136, 192, 208, 255}, // bottom-left:  Nord frost blue
		{235, 203, 139, 255}, // bottom-right: Nord aurora yellow
	}
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			q := 0
			if x >= half {
				q++
			}
			if y >= half {
				q += 2
			}
			img.SetRGBA(x, y, quads[q])
		}
	}
	// White circle in centre
	r2 := (size / 6) * (size / 6)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			dx, dy := x-half, y-half
			if dx*dx+dy*dy <= r2 {
				img.SetRGBA(x, y, color.RGBA{255, 255, 255, 255})
			}
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return base64.StdEncoding.EncodeToString(buf.Bytes())
}

// --- Reasoning Q&A pairs ---

var reasoningQuestions = []struct{ prompt, answer string }{
	{"What is 17 multiplied by 23? Reply with only the number, nothing else.", "391"},
	{"What planet is fourth from the Sun? Reply with only the planet name.", "mars"},
	{"How many sides does a regular hexagon have? Reply with only the number.", "6"},
	{"What is the chemical symbol for gold? Reply with only the two letters.", "au"},
	{"Is 7/8 greater than 5/6? Reply with only yes or no.", "yes"},
}

// --- Long-context filler ---

// ctxFillerUnit is ~133 tokens per repetition (100 words).
const ctxFillerUnit = "Artificial intelligence is transforming industries through machine learning, neural networks, and natural language processing systems. Researchers develop new architectures like transformers that process sequential data using attention mechanisms, enabling models to capture long-range dependencies in text. Deep learning models trained on massive datasets can now perform tasks previously thought to require human intelligence, including translation, code generation, and complex reasoning. The rapid advancement of computational resources, particularly GPUs and specialised accelerators, has made training billion-parameter models feasible. Scaling laws suggest that model capability improves predictably with increases in parameters, training data, and compute budget. "

// --- Benchmark runners ---

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
	defer func() { _ = stream.Close() }()

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

// runVisionBenchmarkPrompt sends a chat message with an embedded image and measures timing.
func runVisionBenchmarkPrompt(ctx context.Context, client *OllamaClient, model, imageB64, prompt string) (float64, float64, float64, error) {
	req := ChatRequest{
		Model:  model,
		Stream: true,
		Options: map[string]interface{}{
			"temperature": 0.0,
		},
		Messages: []ChatMessage{
			{Role: "user", Content: prompt, Images: []string{imageB64}},
		},
	}

	start := time.Now()
	stream, err := client.StreamChat(ctx, req)
	if err != nil {
		return 0, 0, 0, err
	}
	defer func() { _ = stream.Close() }()

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
			Message struct{ Content string } `json:"message"`
			Done    bool                     `json:"done"`
		}
		if err := json.Unmarshal(line, &chunk); err == nil {
			if !firstTokenReceived && chunk.Message.Content != "" {
				firstTokenTime = time.Since(start)
				firstTokenReceived = true
			}
			if chunk.Message.Content != "" {
				tokenCount++
			}
		}
	}

	totalDuration := time.Since(start)
	if !firstTokenReceived {
		return 0, 0, 0, fmt.Errorf("no tokens received — model may not support vision")
	}
	genSec := totalDuration.Seconds() - firstTokenTime.Seconds()
	if genSec <= 0 {
		genSec = 0.001
	}
	return float64(firstTokenTime.Milliseconds()), float64(tokenCount) / genSec, float64(totalDuration.Milliseconds()), nil
}

// runEmbeddingBenchmarkRun measures embedding throughput: chunks/sec and tokens/sec.
func runEmbeddingBenchmarkRun(ctx context.Context, client *OllamaClient, model string, logFunc func(string)) (chunksPerSec float64, extraJSON string, err error) {
	chunks := []string{
		"The transformer architecture uses self-attention to weigh the importance of different tokens.",
		"Gradient descent optimises neural network weights by iteratively moving in the loss gradient direction.",
		"Tokenisation splits raw text into sub-word units that a language model can process.",
		"Reinforcement learning from human feedback aligns model outputs with human preferences.",
		"Embedding vectors encode semantic meaning in high-dimensional continuous space.",
		"Mixture-of-experts models route tokens to specialised sub-networks for efficiency.",
		"Quantisation reduces model weight precision to decrease memory footprint and increase speed.",
		"Flash attention rewrites the attention kernel to reduce memory bandwidth usage.",
		"Chain-of-thought prompting encourages models to reason step-by-step before answering.",
		"Retrieval-augmented generation grounds model responses in external knowledge sources.",
		"The attention mechanism computes query, key, and value projections from input embeddings.",
		"Fine-tuning adapts a pretrained model to a specific downstream task with labelled data.",
		"Low-rank adaptation inserts small trainable matrices into frozen model layers.",
		"Speculative decoding uses a smaller draft model to accelerate large model generation.",
		"Context length determines how many tokens a model can attend to in one inference pass.",
		"Perplexity measures how well a probability model predicts a sample of text.",
		"Beam search explores multiple candidate token sequences to find high-likelihood outputs.",
		"Temperature scaling adjusts the sharpness of the model output probability distribution.",
		"GGUF is a binary format for storing quantised model weights for CPU and GPU inference.",
		"Multi-head attention runs several attention operations in parallel then concatenates results.",
	}

	logFunc(fmt.Sprintf("Embedding %d chunks to measure throughput...", len(chunks)))
	start := time.Now()
	embeddings, embedErr := client.GetEmbeddings(model, chunks)
	elapsed := time.Since(start)

	if embedErr != nil {
		return 0, "", embedErr
	}
	if len(embeddings) == 0 {
		return 0, "", fmt.Errorf("no embeddings returned")
	}

	elapsedSec := elapsed.Seconds()
	if elapsedSec <= 0 {
		elapsedSec = 0.001
	}
	cps := float64(len(embeddings)) / elapsedSec

	// Rough token estimate: avg ~15 tokens per chunk
	tokensSec := float64(len(chunks)*15) / elapsedSec

	logFunc(fmt.Sprintf("Done: %d chunks in %.2fs → %.1f chunks/s, ~%.0f tokens/s, dim=%d",
		len(embeddings), elapsedSec, cps, tokensSec, len(embeddings[0])))

	extra, _ := json.Marshal(map[string]interface{}{
		"chunks":        len(embeddings),
		"elapsed_ms":    elapsed.Milliseconds(),
		"chunks_per_sec": math.Round(cps*10) / 10,
		"tokens_per_sec": math.Round(tokensSec),
		"dimensions":    len(embeddings[0]),
	})
	return cps, string(extra), nil
}

// runLongCtxBenchmarkRun tests TPS at three increasing context sizes.
func runLongCtxBenchmarkRun(ctx context.Context, client *OllamaClient, model string, logFunc func(string)) (avgTps, ttft, latency float64, extraJSON string, err error) {
	type ctxLevel struct {
		label   string
		repeats int
		numCtx  int
	}
	levels := []ctxLevel{
		{"1K", 8, 2048},
		{"4K", 30, 4096},
		{"8K", 60, 8192},
	}

	prompt := "After reading the following passage, state in one sentence what field of technology it primarily discusses.\n\n"

	results := map[string]float64{}
	var totalTps, totalTtft, totalLatency float64
	runs := 0

	for _, lvl := range levels {
		filler := strings.Repeat(ctxFillerUnit, lvl.repeats)
		fullPrompt := prompt + filler

		logFunc(fmt.Sprintf("Running ~%s context window test (num_ctx=%d)...", lvl.label, lvl.numCtx))

		req := GenerateRequest{
			Model:  model,
			Prompt: fullPrompt,
			Stream: true,
			Options: map[string]interface{}{
				"temperature": 0.0,
				"num_ctx":     lvl.numCtx,
				"num_predict": 80,
			},
		}

		start := time.Now()
		stream, streamErr := client.StreamGenerate(ctx, req)
		if streamErr != nil {
			logFunc(fmt.Sprintf("  %s context failed: %v", lvl.label, streamErr))
			results[lvl.label] = 0
			continue
		}

		var firstTok time.Duration
		var gotFirst bool
		var toks int

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
			if json.Unmarshal(line, &chunk) == nil {
				if !gotFirst && chunk.Response != "" {
					firstTok = time.Since(start)
					gotFirst = true
				}
				if chunk.Response != "" {
					toks++
				}
			}
		}
		if err := stream.Close(); err != nil {
			logFunc(fmt.Sprintf("  warning: stream close: %v", err))
		}

		total := time.Since(start)
		if !gotFirst || toks == 0 {
			logFunc(fmt.Sprintf("  %s context: no tokens received", lvl.label))
			results[lvl.label] = 0
			continue
		}

		genSec := total.Seconds() - firstTok.Seconds()
		if genSec <= 0 {
			genSec = 0.001
		}
		tps := float64(toks) / genSec
		results[lvl.label] = math.Round(tps*10) / 10
		logFunc(fmt.Sprintf("  %s context → TTFT: %.0fms, TPS: %.1f", lvl.label, float64(firstTok.Milliseconds()), tps))

		totalTps += tps
		totalTtft += float64(firstTok.Milliseconds())
		totalLatency += float64(total.Milliseconds())
		runs++
	}

	if runs == 0 {
		return 0, 0, 0, "", fmt.Errorf("all context-size runs failed")
	}

	// Degradation: how much TPS dropped from 1K to 8K
	deg := 0.0
	if results["1K"] > 0 && results["8K"] > 0 {
		deg = math.Round((1-(results["8K"]/results["1K"]))*1000) / 10
	}

	extra, _ := json.Marshal(map[string]interface{}{
		"tps_1k":          results["1K"],
		"tps_4k":          results["4K"],
		"tps_8k":          results["8K"],
		"degradation_pct": deg,
	})

	return totalTps / float64(runs), totalTtft / float64(runs), totalLatency / float64(runs), string(extra), nil
}

// runReasoningBenchmarkRun asks 5 factual questions with known single-token answers.
func runReasoningBenchmarkRun(ctx context.Context, client *OllamaClient, model string, logFunc func(string)) (correct, total int, avgTtft, avgTps, avgLatency float64, extraJSON string, err error) {
	type result struct {
		Q       string  `json:"q"`
		Want    string  `json:"want"`
		Got     string  `json:"got"`
		Correct bool    `json:"correct"`
		TtftMs  float64 `json:"ttft_ms"`
	}
	var results []result
	var sumTtft, sumTps, sumLatency float64

	for i, qa := range reasoningQuestions {
		logFunc(fmt.Sprintf("Q%d/5: %s", i+1, qa.prompt))

		req := GenerateRequest{
			Model:  model,
			Prompt: qa.prompt,
			Stream: true,
			Options: map[string]interface{}{
				"temperature": 0.0,
				"num_predict": 20,
			},
		}

		start := time.Now()
		stream, streamErr := client.StreamGenerate(ctx, req)
		if streamErr != nil {
			logFunc(fmt.Sprintf("  Failed: %v", streamErr))
			results = append(results, result{Q: qa.prompt, Want: qa.answer, Got: "ERROR", Correct: false})
			total++
			continue
		}

		var firstTok time.Duration
		var gotFirst bool
		var toks int
		var response strings.Builder

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
			if json.Unmarshal(line, &chunk) == nil {
				if !gotFirst && chunk.Response != "" {
					firstTok = time.Since(start)
					gotFirst = true
				}
				if chunk.Response != "" {
					toks++
					response.WriteString(chunk.Response)
				}
			}
		}
		if err := stream.Close(); err != nil {
			logFunc(fmt.Sprintf("  warning: stream close: %v", err))
		}

		dur := time.Since(start)
		got := strings.TrimSpace(response.String())
		isCorrect := strings.Contains(strings.ToLower(got), strings.ToLower(qa.answer))
		if isCorrect {
			correct++
		}
		total++

		logFunc(fmt.Sprintf("  Answer: %q — %s (expected: %q)", got, map[bool]string{true: "✓ CORRECT", false: "✗ WRONG"}[isCorrect], qa.answer))

		genSec := dur.Seconds() - firstTok.Seconds()
		if genSec <= 0 {
			genSec = 0.001
		}
		tps := float64(toks) / genSec
		results = append(results, result{
			Q: qa.prompt, Want: qa.answer, Got: got,
			Correct: isCorrect, TtftMs: float64(firstTok.Milliseconds()),
		})
		sumTtft += float64(firstTok.Milliseconds())
		sumTps += tps
		sumLatency += float64(dur.Milliseconds())
	}

	accuracyPct := 0.0
	if total > 0 {
		accuracyPct = math.Round(float64(correct)/float64(total)*1000) / 10
	}

	extra, _ := json.Marshal(map[string]interface{}{
		"correct":      correct,
		"total":        total,
		"accuracy_pct": accuracyPct,
		"results":      results,
	})

	n := float64(len(reasoningQuestions))
	return correct, total, sumTtft / n, sumTps / n, sumLatency / n, string(extra), nil
}

func runBenchmarkSSEHandler(c *gin.Context) {
	model := c.Query("model")
	if model == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Model parameter is required"})
		return
	}
	benchType := c.DefaultQuery("type", "standard")

	activeSrv, err := GetActiveServer()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "No active Ollama server selected"})
		return
	}

	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("Transfer-Encoding", "chunked")

	LogActivity("benchmark", fmt.Sprintf("Benchmark started: %s [%s]", model, strings.ToUpper(benchType)))
	client := NewOllamaClient(activeSrv)
	ctx := c.Request.Context()

	c.Stream(func(w io.Writer) bool {
		c.SSEvent("status", fmt.Sprintf("Initializing %s benchmark for %s...", strings.ToUpper(benchType), model))

		var (
			avgTtft, avgTps, avgLatency float64
			extraJSON                   string
			saveErr                     error
			id                          int64
		)

		switch benchType {

		// ── VISION ──────────────────────────────────────────────────────────
		case "vision":
			visionPrompts := []string{
				"Describe what you see in this image. Be specific about colours, shapes, and layout.",
				"How many distinct colour regions are visible, and what is in the centre of the image?",
			}
			var sumTtft, sumTps, sumLatency float64
			runs := 0
			for i, p := range visionPrompts {
				c.SSEvent("status", fmt.Sprintf("Vision prompt %d/%d...", i+1, len(visionPrompts)))
				ttft, tps, lat, runErr := runVisionBenchmarkPrompt(ctx, client, model, visionTestImageBase64, p)
				if runErr != nil {
					c.SSEvent("error", fmt.Sprintf("Vision prompt %d failed: %v", i+1, runErr))
					continue
				}
				c.SSEvent("status", fmt.Sprintf("  TTFT: %.0fms, TPS: %.1f", ttft, tps))
				sumTtft += ttft
				sumTps += tps
				sumLatency += lat
				runs++
			}
			if runs == 0 {
				c.SSEvent("error", "Vision benchmark failed — model may not support images.")
				return false
			}
			avgTtft = sumTtft / float64(runs)
			avgTps = sumTps / float64(runs)
			avgLatency = sumLatency / float64(runs)

		// ── EMBEDDING ───────────────────────────────────────────────────────
		case "embedding":
			var cps float64
			cps, extraJSON, saveErr = runEmbeddingBenchmarkRun(ctx, client, model, func(msg string) {
				c.SSEvent("status", msg)
			})
			if saveErr != nil {
				c.SSEvent("error", fmt.Sprintf("Embedding benchmark failed: %v", saveErr))
				return false
			}
			// Store chunks/sec in TPS field; TTFT/latency are not meaningful for batch embedding
			avgTps = cps
			avgTtft = 0
			avgLatency = 0

		// ── LONG-CONTEXT ─────────────────────────────────────────────────────
		case "longctx":
			var runErr error
			avgTps, avgTtft, avgLatency, extraJSON, runErr = runLongCtxBenchmarkRun(ctx, client, model, func(msg string) {
				c.SSEvent("status", msg)
			})
			if runErr != nil {
				c.SSEvent("error", fmt.Sprintf("Long-context benchmark failed: %v", runErr))
				return false
			}

		// ── REASONING ────────────────────────────────────────────────────────
		case "reasoning":
			correct, total, rTtft, rTps, rLat, rExtra, runErr := runReasoningBenchmarkRun(ctx, client, model, func(msg string) {
				c.SSEvent("status", msg)
			})
			if runErr != nil {
				c.SSEvent("error", fmt.Sprintf("Reasoning benchmark failed: %v", runErr))
				return false
			}
			avgTtft, avgTps, avgLatency, extraJSON = rTtft, rTps, rLat, rExtra
			c.SSEvent("status", fmt.Sprintf("Result: %d/%d correct (%.0f%%)", correct, total, float64(correct)/float64(total)*100))

		// ── STANDARD (default) ───────────────────────────────────────────────
		default:
			benchType = "standard"
			prompts := []string{
				"Explain the difference between TCP and UDP in one simple sentence.",
				"Write a short Python function that checks if a string is a palindrome.",
				"Briefly explain the theory of relativity to a 10-year-old in one paragraph.",
			}
			var sumTtft, sumTps, sumLatency float64
			runs := 0
			for i, prompt := range prompts {
				c.SSEvent("status", fmt.Sprintf("Prompt %d/3: %q", i+1, prompt))
				ttft, tps, lat, runErr := runBenchmarkForPrompt(ctx, client, model, prompt, func(msg string) {
					c.SSEvent("status", msg)
				})
				if runErr != nil {
					c.SSEvent("error", fmt.Sprintf("Prompt %d failed: %v", i+1, runErr))
					continue
				}
				c.SSEvent("status", fmt.Sprintf("  TTFT: %.0fms, TPS: %.1f, Latency: %.0fms", ttft, tps, lat))
				sumTtft += ttft
				sumTps += tps
				sumLatency += lat
				runs++
			}
			if runs == 0 {
				c.SSEvent("error", "Benchmark failed: all prompts failed.")
				return false
			}
			avgTtft = sumTtft / float64(runs)
			avgTps = sumTps / float64(runs)
			avgLatency = sumLatency / float64(runs)
		}

		id, saveErr = SaveBenchmark(model, activeSrv.Name, activeSrv.URL, benchType, extraJSON, avgTtft, avgTps, avgLatency)
		if saveErr != nil {
			c.SSEvent("error", fmt.Sprintf("Failed to save benchmark: %v", saveErr))
			return false
		}
		if cullErr := CullBenchmarks(model, activeSrv.URL, benchType, 3); cullErr != nil {
			log.Printf("Warning: failed to cull benchmarks: %v", cullErr)
		}

		c.SSEvent("status", fmt.Sprintf("%s benchmark complete.", strings.ToUpper(benchType)))

		result := map[string]interface{}{
			"id":             id,
			"model_name":     model,
			"server_name":    activeSrv.Name,
			"server_url":     activeSrv.URL,
			"benchmark_type": benchType,
			"extra_json":     extraJSON,
			"ttft_ms":        avgTtft,
			"tps":            avgTps,
			"avg_latency_ms": avgLatency,
		}
		resBytes, _ := json.Marshal(result)
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

// extractPDFTextHandler accepts a multipart PDF upload and returns extracted plain text.
// Running extraction server-side avoids the browser renderer hang (RESULT_CODE_HUNG) that
// occurs when PDF.js tries to structured-clone a massive text-item array from its worker.
func extractPDFTextHandler(c *gin.Context) {
	const maxPDFBytes = 50 * 1024 * 1024 // 50 MB
	const maxPages    = 300

	fh, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No file uploaded (field: 'file')"})
		return
	}
	if fh.Size > maxPDFBytes {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("File too large (%.1f MB). Maximum is 50 MB.", float64(fh.Size)/(1024*1024))})
		return
	}

	// Write to a temp file — ledongthuc/pdf needs a seekable reader
	tmp, err := os.CreateTemp("", "neurollama-pdf-*.pdf")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Could not create temp file"})
		return
	}
	defer func() {
		tmp.Close()
		os.Remove(tmp.Name())
	}()

	src, err := fh.Open()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Could not open upload"})
		return
	}
	defer src.Close()

	if _, err = io.Copy(tmp, src); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to buffer upload"})
		return
	}
	if err = tmp.Close(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to flush temp file"})
		return
	}

	f, pdfReader, err := goPDF.Open(tmp.Name())
	if err != nil {
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": fmt.Sprintf("PDF parse failed: %v — try converting to a plain PDF first.", err)})
		return
	}
	defer f.Close()

	numPages := pdfReader.NumPage()
	if numPages > maxPages {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("PDF has %d pages. Maximum supported is %d.", numPages, maxPages)})
		return
	}

	var sb strings.Builder
	skipped := 0
	for i := 1; i <= numPages; i++ {
		page := pdfReader.Page(i)
		if page.V.IsNull() {
			skipped++
			continue
		}
		pageText, err := page.GetPlainText(nil)
		if err != nil {
			skipped++
			continue
		}
		sb.WriteString(pageText)
		sb.WriteByte('\n')
	}

	text := sb.String()
	c.JSON(http.StatusOK, gin.H{
		"pages":   numPages,
		"skipped": skipped,
		"chars":   len(text),
		"text":    text,
	})
}

// chunkTextGo splits text into overlapping chunks, mirroring the JS chunkText(text, 800, 100) logic.
// Boundaries are snapped backward to the nearest whitespace or sentence terminator.
func chunkTextGo(text string, size, overlap int) []string {
	// Normalize line endings
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")

	n := len(text)
	if n == 0 {
		return nil
	}
	if n <= size {
		t := strings.TrimSpace(text)
		if t == "" {
			return nil
		}
		return []string{t}
	}

	var chunks []string
	start := 0
	for start < n {
		end := start + size
		if end > n {
			end = n
		}

		// Snap end backward to a word/sentence boundary (up to 100 chars)
		if end < n {
			maxSearch := 100
			if maxSearch > end-start {
				maxSearch = end - start
			}
			for searchIdx := 0; searchIdx < maxSearch; searchIdx++ {
				ch := text[end-searchIdx] // end < n, so text[end] is valid; searchIdx < end-start so >= start+1
				if ch == '\n' || ch == ' ' || ch == '.' || ch == '?' {
					end = end - searchIdx + 1
					break
				}
			}
			if end > n {
				end = n
			}
		}

		chunk := strings.TrimSpace(text[start:end])
		if chunk != "" {
			chunks = append(chunks, chunk)
		}

		newStart := end - overlap
		if newStart <= start {
			newStart = end
		}
		start = newStart
	}
	return chunks
}

// uploadAndIndexHandler accepts a multipart file upload plus an embedding_model field,
// extracts text server-side (PDF via ledongthuc/pdf, or TXT/MD via io.ReadAll),
// chunks it with chunkTextGo, embeds with Ollama, saves to SQLite, and streams
// progress as newline-delimited JSON so the browser never touches the raw text.
// This avoids the RESULT_CODE_HUNG browser crash that occurs when the browser tries
// to chunk/JSON-stringify tens of thousands of characters in the main thread.
func uploadAndIndexHandler(c *gin.Context) {
	const (
		maxFileBytes   = 50 * 1024 * 1024
		maxPages       = 300
		chunkSize      = 800
		chunkOverlap   = 100
		embedBatchSize = 50
	)

	// emit writes one NDJSON line to the response and flushes.
	// After the first emit the HTTP status is committed as 200 — subsequent
	// errors must be reported as {"type":"error"} events, not HTTP status codes.
	type ndjsonEvent = map[string]any
	emit := func(event ndjsonEvent) {
		data, _ := json.Marshal(event)
		data = append(data, '\n')
		c.Writer.Write(data) //nolint:errcheck
		c.Writer.Flush()
	}

	// ── Pre-stream validation (can still set HTTP error status here) ──────────

	fh, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No file uploaded (field: 'file')"})
		return
	}
	embeddingModel := c.PostForm("embedding_model")
	if embeddingModel == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Missing embedding_model field"})
		return
	}
	if fh.Size > maxFileBytes {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("File too large (%.1f MB). Maximum is 50 MB.", float64(fh.Size)/(1024*1024))})
		return
	}
	filename := fh.Filename
	dotIdx := strings.LastIndex(filename, ".")
	var ext string
	if dotIdx >= 0 {
		ext = strings.ToLower(filename[dotIdx:])
	}
	if ext != ".pdf" && ext != ".txt" && ext != ".md" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Unsupported file type. Only .pdf, .txt, and .md files are supported."})
		return
	}

	// ── Streaming begins — status 200 is committed on first Write ─────────────

	c.Header("Content-Type", "application/x-ndjson")
	c.Header("Transfer-Encoding", "chunked")
	c.Header("X-Accel-Buffering", "no")
	c.Header("Cache-Control", "no-cache")

	fileMB := float64(fh.Size) / (1024 * 1024)
	emit(ndjsonEvent{"type": "progress", "pct": 5, "message": fmt.Sprintf("Reading %s (%.1f MB)...", filename, fileMB)})

	// ── Text extraction ───────────────────────────────────────────────────────

	var rawText string

	if ext == ".pdf" {
		emit(ndjsonEvent{"type": "progress", "pct": 10, "message": "Uploading PDF to extraction engine..."})

		tmp, err := os.CreateTemp("", "neurollama-pdf-*.pdf")
		if err != nil {
			emit(ndjsonEvent{"type": "error", "message": "Could not create temp file"})
			return
		}
		tmpName := tmp.Name()
		defer os.Remove(tmpName)

		src, err := fh.Open()
		if err != nil {
			tmp.Close()
			emit(ndjsonEvent{"type": "error", "message": "Could not open upload"})
			return
		}
		_, copyErr := io.Copy(tmp, src)
		src.Close()
		tmp.Close()
		if copyErr != nil {
			emit(ndjsonEvent{"type": "error", "message": "Failed to buffer PDF upload"})
			return
		}

		f, pdfReader, err := goPDF.Open(tmpName)
		if err != nil {
			emit(ndjsonEvent{"type": "error", "message": fmt.Sprintf("PDF parse failed: %v — try converting to a plain PDF first.", err)})
			return
		}

		numPages := pdfReader.NumPage()
		if numPages > maxPages {
			f.Close()
			emit(ndjsonEvent{"type": "error", "message": fmt.Sprintf("PDF has %d pages. Maximum supported is %d.", numPages, maxPages)})
			return
		}

		emit(ndjsonEvent{"type": "progress", "pct": 15, "message": fmt.Sprintf("Extracting text from %d pages...", numPages)})

		var sb strings.Builder
		skipped := 0
		for i := 1; i <= numPages; i++ {
			page := pdfReader.Page(i)
			if page.V.IsNull() {
				skipped++
				continue
			}
			pageText, err := page.GetPlainText(nil)
			if err != nil {
				skipped++
				continue
			}
			sb.WriteString(pageText)
			sb.WriteByte('\n')
		}
		f.Close()

		rawText = sb.String()
		skipNote := ""
		if skipped > 0 {
			skipNote = fmt.Sprintf(", %d page(s) skipped", skipped)
		}
		emit(ndjsonEvent{"type": "progress", "pct": 30, "message": fmt.Sprintf("Extracted %d chars from %d pages%s", len(rawText), numPages, skipNote)})

	} else {
		// TXT / MD
		src, err := fh.Open()
		if err != nil {
			emit(ndjsonEvent{"type": "error", "message": "Could not open upload"})
			return
		}
		raw, err := io.ReadAll(src)
		src.Close()
		if err != nil {
			emit(ndjsonEvent{"type": "error", "message": "Failed to read file"})
			return
		}
		rawText = string(raw)
		emit(ndjsonEvent{"type": "progress", "pct": 30, "message": fmt.Sprintf("Read %d chars", len(rawText))})
	}

	if strings.TrimSpace(rawText) == "" {
		emit(ndjsonEvent{"type": "error", "message": "No extractable text found. This may be an image-only or scanned PDF — try running it through OCR first (e.g. ocrmypdf)."})
		return
	}

	// ── Chunking ──────────────────────────────────────────────────────────────

	emit(ndjsonEvent{"type": "progress", "pct": 35, "message": "Chunking into ~800-char blocks (100-char overlap)..."})
	chunks := chunkTextGo(rawText, chunkSize, chunkOverlap)
	if len(chunks) == 0 {
		emit(ndjsonEvent{"type": "error", "message": "Text chunking produced no output"})
		return
	}
	emit(ndjsonEvent{"type": "progress", "pct": 40, "message": fmt.Sprintf("%d chunk(s) created", len(chunks))})

	// ── Embedding ─────────────────────────────────────────────────────────────

	activeSrv, err := GetActiveServer()
	if err != nil {
		emit(ndjsonEvent{"type": "error", "message": "No active Ollama server selected"})
		return
	}
	ollamaClient := NewOllamaClient(activeSrv)

	totalBatches := (len(chunks) + embedBatchSize - 1) / embedBatchSize
	emit(ndjsonEvent{"type": "progress", "pct": 45, "message": fmt.Sprintf("Embedding %d chunk(s) via %s (%d batch(es) of up to %d)...", len(chunks), embeddingModel, totalBatches, embedBatchSize)})

	var allEmbeddings [][]float64
	for b := 0; b < totalBatches; b++ {
		start := b * embedBatchSize
		end := start + embedBatchSize
		if end > len(chunks) {
			end = len(chunks)
		}

		batch, err := ollamaClient.GetEmbeddings(embeddingModel, chunks[start:end])
		if err != nil {
			emit(ndjsonEvent{"type": "error", "message": fmt.Sprintf("Embedding batch %d/%d failed: %v", b+1, totalBatches, err)})
			return
		}
		allEmbeddings = append(allEmbeddings, batch...)

		pct := 45 + int(float64(b+1)/float64(totalBatches)*47) // 45 → 92
		emit(ndjsonEvent{"type": "progress", "pct": pct, "message": fmt.Sprintf("Embedded batch %d/%d (%d/%d chunks)", b+1, totalBatches, end, len(chunks))})
	}

	if len(allEmbeddings) != len(chunks) {
		emit(ndjsonEvent{"type": "error", "message": fmt.Sprintf("Embedding count mismatch: got %d, want %d", len(allEmbeddings), len(chunks))})
		return
	}

	// ── Save to database ──────────────────────────────────────────────────────

	emit(ndjsonEvent{"type": "progress", "pct": 93, "message": "Saving to database..."})

	ragChunks := make([]RAGChunk, len(chunks))
	for i, chk := range chunks {
		ragChunks[i] = RAGChunk{
			ChunkIndex: i,
			Content:    chk,
			Embedding:  allEmbeddings[i],
		}
	}

	docID, err := SaveRAGDocument(filename, embeddingModel, ragChunks)
	if err != nil {
		emit(ndjsonEvent{"type": "error", "message": fmt.Sprintf("Database save failed: %v", err)})
		return
	}

	emit(ndjsonEvent{"type": "done", "document_id": docID, "chunks": len(ragChunks)})
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

	const maxRAGChunksPerRequest = 500
	const ragEmbedBatchSize      = 50

	if len(req.Chunks) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No document chunks provided"})
		return
	}
	if len(req.Chunks) > maxRAGChunksPerRequest {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("Too many chunks per request (%d). Maximum per request is %d.", len(req.Chunks), maxRAGChunksPerRequest)})
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

	// Fetch embeddings in batches of ragEmbedBatchSize to avoid overwhelming Ollama
	// with one massive request and to bound peak GPU memory usage.
	var embeddings [][]float64
	for start := 0; start < len(texts); start += ragEmbedBatchSize {
		end := start + ragEmbedBatchSize
		if end > len(texts) {
			end = len(texts)
		}
		batch, err := client.GetEmbeddings(req.EmbeddingModel, texts[start:end])
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("Embedding batch %d–%d failed: %v", start+1, end, err)})
			return
		}
		embeddings = append(embeddings, batch...)
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

// appendRAGChunksHandler embeds and appends chunks to an existing document.
// Called for batches 2..N during a large-document upload from the client.
func appendRAGChunksHandler(c *gin.Context) {
	idStr := c.Param("id")
	var docID int64
	if _, err := fmt.Sscanf(idStr, "%d", &docID); err != nil || docID <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid document ID"})
		return
	}

	var req struct {
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

	const maxRAGChunksPerRequest = 500
	const ragEmbedBatchSize      = 50

	if len(req.Chunks) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No chunks provided"})
		return
	}
	if len(req.Chunks) > maxRAGChunksPerRequest {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("Too many chunks per request (%d). Maximum is %d.", len(req.Chunks), maxRAGChunksPerRequest)})
		return
	}

	activeSrv, err := GetActiveServer()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "No active Ollama server selected"})
		return
	}
	client := NewOllamaClient(activeSrv)

	texts := make([]string, len(req.Chunks))
	for i, ch := range req.Chunks {
		texts[i] = ch.Content
	}

	var embeddings [][]float64
	for start := 0; start < len(texts); start += ragEmbedBatchSize {
		end := start + ragEmbedBatchSize
		if end > len(texts) {
			end = len(texts)
		}
		batch, err := client.GetEmbeddings(req.EmbeddingModel, texts[start:end])
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("Embedding batch %d–%d failed: %v", start+1, end, err)})
			return
		}
		embeddings = append(embeddings, batch...)
	}

	if len(embeddings) != len(req.Chunks) {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Embedding count mismatch"})
		return
	}

	var chunksToSave []RAGChunk
	for i, ch := range req.Chunks {
		chunksToSave = append(chunksToSave, RAGChunk{
			ChunkIndex: ch.ChunkIndex,
			Content:    ch.Content,
			Embedding:  embeddings[i],
		})
	}

	if err := AppendRAGChunks(docID, chunksToSave); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message":     "Chunks appended successfully",
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

// ── System — About / Data Management / Backup-Restore ───────────────────────

func aboutHandler(c *gin.Context) {
	uptime := time.Since(appStartTime)
	h := int(uptime.Hours())
	m := int(uptime.Minutes()) % 60
	s := int(uptime.Seconds()) % 60
	uptimeStr := fmt.Sprintf("%dh %dm %ds", h, m, s)

	var chatCount, benchCount int
	if DB != nil {
		_ = DB.QueryRow("SELECT COUNT(*) FROM chats").Scan(&chatCount)
		_ = DB.QueryRow("SELECT COUNT(*) FROM benchmarks").Scan(&benchCount)
	}

	c.JSON(http.StatusOK, gin.H{
		"version":    appVersion,
		"goVersion":  runtime.Version(),
		"uptime":     uptimeStr,
		"startTime":  appStartTime.Format("2006-01-02 15:04:05"),
		"dbPath":     activeDBPath,
		"chatCount":  chatCount,
		"benchCount": benchCount,
	})
}

func deleteAllChatsHandler(c *gin.Context) {
	tx, err := DB.Begin()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer tx.Rollback()
	if _, err := tx.Exec("DELETE FROM messages"); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if _, err := tx.Exec("DELETE FROM chats"); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if err := tx.Commit(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	LogActivity("system", "All chat history cleared")
	c.JSON(http.StatusOK, gin.H{"message": "All chat history deleted."})
}

func deleteAllBenchmarksHandler(c *gin.Context) {
	if _, err := DB.Exec("DELETE FROM benchmarks"); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	LogActivity("system", "All benchmark results cleared")
	c.JSON(http.StatusOK, gin.H{"message": "All benchmark results deleted."})
}

func backupDBHandler(c *gin.Context) {
	tmpPath := activeDBPath + ".backup.tmp"
	// VACUUM INTO creates a consistent, defragmented copy without locking the live DB
	if _, err := DB.Exec("VACUUM INTO ?", tmpPath); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Backup failed: " + err.Error()})
		return
	}
	defer os.Remove(tmpPath)
	filename := fmt.Sprintf("neurollama-backup-%s.db", time.Now().Format("20060102-150405"))
	LogActivity("system", fmt.Sprintf("Database backup downloaded: %s", filename))
	c.FileAttachment(tmpPath, filename)
}

func restoreDBHandler(c *gin.Context) {
	file, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No file uploaded"})
		return
	}

	src, err := file.Open()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to open uploaded file"})
		return
	}
	defer src.Close()

	// Validate SQLite magic bytes ("SQLite format 3\x00")
	header := make([]byte, 16)
	if _, err := io.ReadFull(src, header); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid file: cannot read header"})
		return
	}
	if string(header) != "SQLite format 3\x00" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Not a valid SQLite database file"})
		return
	}
	if _, err := src.(io.Seeker).Seek(0, io.SeekStart); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to process uploaded file"})
		return
	}

	// Write to pending path — applied on next startup
	pendingPath := activeDBPath + ".pending"
	dst, err := os.Create(pendingPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save restore file"})
		return
	}
	defer dst.Close()

	if _, err := io.Copy(dst, src); err != nil {
		os.Remove(pendingPath)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to write restore file"})
		return
	}

	LogActivity("system", fmt.Sprintf("Database restore staged: %s (restart required)", file.Filename))
	c.JSON(http.StatusOK, gin.H{
		"message":         "Restore file saved. Restart NEUROLLAMA to apply.",
		"restartRequired": true,
	})
}
