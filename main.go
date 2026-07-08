package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
)

// appVersion is the default for local dev; CI overrides via -ldflags "-X main.appVersion=<tag>"
var appVersion = "v0.2.25-beta.14"

// agentVersion is the canonical neuro-agent version this build expects on fleet nodes
var agentVersion = "v0.1.1"

// releaseType is "dev" by default; CI overrides via -ldflags "-X main.releaseType=pre-release|stable"
var releaseType = "dev"

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
	Name             string  `json:"name" binding:"required"`
	URL              string  `json:"url" binding:"required"`
	VramGB           float64 `json:"vramGb"`
	AuthType         string  `json:"authType"`
	AuthToken        string  `json:"authToken"`
	AuthUsername     string  `json:"authUsername"`
	AuthPassword     string  `json:"authPassword"`
	AuthHeaderName   string  `json:"authHeaderName"`
	AuthHeaderVal    string  `json:"authHeaderVal"`
	AgentPort        int     `json:"agentPort"`
	AgentKey         string  `json:"agentKey"`
	AgentFingerprint string  `json:"agentFingerprint"`
}

type EditServerRequest struct {
	Name             string  `json:"name" binding:"required"`
	URL              string  `json:"url" binding:"required"`
	VramGB           float64 `json:"vramGb"`
	AuthType         string  `json:"authType"`
	AuthToken        string  `json:"authToken"`
	AuthUsername     string  `json:"authUsername"`
	AuthPassword     string  `json:"authPassword"`
	AuthHeaderName   string  `json:"authHeaderName"`
	AuthHeaderVal    string  `json:"authHeaderVal"`
	AgentPort        int     `json:"agentPort"`
	AgentKey         string  `json:"agentKey"`
	AgentFingerprint string  `json:"agentFingerprint"`
	AgentSSHUser     string  `json:"agentSSHUser"`
	AgentSSHPort     int     `json:"agentSSHPort"`
	AgentSSHKeyID    string  `json:"agentSSHKeyID"`
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
	portFlag := flag.Int("port", 0, "Port to listen on (overrides PORT env var, default 8811)")
	showVersion := flag.Bool("version", false, "Print version and exit")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "NEUROLLAMA %s — Ollama node control panel\n\n", appVersion)
		fmt.Fprintf(os.Stderr, "Usage:\n  neurollama [flags]\n\nFlags:\n")
		flag.PrintDefaults()
		fmt.Fprintf(os.Stderr, "\nEnvironment variables:\n")
		fmt.Fprintf(os.Stderr, "  PORT          Port to listen on (default 8811)\n")
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
	seedActivityFromDB()

	// Start background pollers and scheduler
	startNodeCachePoller() // warms node-status and model-list caches before first request
	startTelemetryPoller()
	startSchedulerTicker()

	r := gin.Default()
	trustedProxies := os.Getenv("TRUSTED_PROXIES")
	if trustedProxies == "" {
		trustedProxies = "127.0.0.1,::1"
	}
	if trustedProxies == "none" {
		if err := r.SetTrustedProxies(nil); err != nil {
			log.Printf("Warning: SetTrustedProxies(nil): %v", err)
		}
	} else {
		var proxies []string
		for _, p := range strings.Split(trustedProxies, ",") {
			if p = strings.TrimSpace(p); p != "" {
				proxies = append(proxies, p)
			}
		}
		if err := r.SetTrustedProxies(proxies); err != nil {
			log.Printf("Warning: SetTrustedProxies(%v): %v", proxies, err)
		}
	}

	// Load HTML templates
	r.LoadHTMLGlob("templates/*")

	// Serve static files
	r.Static("/static", "./static")
	r.StaticFile("/favicon.ico", "./static/img/favicon.ico")

	// Health check — used by Docker HEALTHCHECK and load balancers
	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "version": appVersion, "agent_version": agentVersion})
	})

	// HTML routes
	r.GET("/", func(c *gin.Context) {
		c.HTML(http.StatusOK, "index.html", gin.H{
			"title":   "NEUROLLAMA 2026",
			"version": appVersion,
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
		api.GET("/models/search", searchModelsHandler)
		api.GET("/models/detail", getModelDetailHandler)
		api.POST("/models/delete", deleteModelsHandler)
		api.POST("/models/copy", copyModelHandler)
		api.GET("/models/pull", pullModelSSEHandler)
		api.GET("/models/card", getModelCardHandler)
		api.GET("/models/ctx-lengths",   modelCtxLengthsHandler)
		api.GET("/models/capabilities", modelCapabilitiesHandler)

		// Handlers for v0.0.2
		api.GET("/models/active", getActiveModelsHandler)
		api.POST("/models/unload", unloadModelHandler)
		api.POST("/chat", chatStreamHandler)
		api.POST("/generate", generateStreamHandler)
		api.POST("/models/create", createModelStreamHandler)

		// Handlers for v0.0.3 SQLite Persistence & Presets
		api.GET("/chats", getChatsHandler)
		api.GET("/chats/search", searchChatsHandler)
		api.GET("/chats/:id", getChatMessagesHandler)
		api.POST("/chats", createChatHandler)
		api.PUT("/chats/:id", updateChatHandler)
		api.PATCH("/chats/:id/title", renameChatHandler)
		api.DELETE("/chats/:id", deleteChatHandler)
		api.GET("/presets", getPresetsHandler)
		api.POST("/presets", createPresetHandler)
		api.DELETE("/presets/:id", deletePresetHandler)

		// Node management
		api.GET("/nodes/overview", nodesOverviewHandler)
		api.POST("/nodes/:id/refresh", refreshNodeHandler)
		api.POST("/nodes/:id/unload", unloadNodeModelHandler)
		api.POST("/nodes/:id/agent-test", testNodeAgentHandler)
		api.POST("/nodes/:id/agent-deploy", agentDeploySSEHandler)

		// Pull Bootstrap Agent Ingestion
		api.GET("/fleet/bootstrap", bootstrapAgentHandler)
		api.GET("/fleet/download-agent/:os/:arch", downloadAgentBinaryHandler)
		api.POST("/fleet/register-agent", registerAgentHandler)

		// Telemetry & Scheduler endpoints
		api.GET("/settings", getSettingsHandler)
		api.PUT("/settings", updateSettingHandler)
		api.GET("/scheduler/logs", getSchedulerLogsHandler)
		api.POST("/scheduler/check", checkModelUpdatesNowHandler)
		api.GET("/telemetry/stream", telemetryStreamHandler)

		// Context Compression & Branching
		api.POST("/chats/:id/compress", compressChatHandler)
		api.POST("/chats/:id/trim", trimChatHandler)

		// Benchmarks
		api.GET("/benchmarks", getBenchmarksHandler)
		api.GET("/benchmarks/grouped", getGroupedBenchmarksHandler)
		api.GET("/benchmarks/export.csv", exportBenchmarksCSVHandler)
		api.GET("/benchmarks/run", runBenchmarkSSEHandler)
		api.GET("/benchmarks/node-vs-node", nodeVsNodeBenchmarkHandler)
		api.GET("/benchmarks/nvn-leaderboard", nvnLeaderboardHandler)
		api.GET("/benchmarks/nvn-matches", nvnMatchesHandler)
		api.DELETE("/benchmarks/nvn-matches/:id", deleteNvnMatchHandler)
		api.PUT("/benchmarks/:id/score", updateBenchmarkScoreHandler)
		api.DELETE("/benchmarks/:id", deleteBenchmarkHandler)

		// Code benchmark
		api.GET("/benchmarks/code", getCodeBenchmarksHandler)
		api.GET("/benchmarks/code/run", runCodeBenchmarkSSEHandler)
		api.GET("/benchmarks/code/checkers", codeSyntaxCheckersHandler)
		api.DELETE("/benchmarks/code/:id", deleteCodeBenchmarkHandler)

		// Inventory badges summary (lightweight, used by inventory tab)
		api.GET("/benchmarks/model-summary", modelBenchSummaryHandler)

		// Hallucination
		api.GET("/benchmarks/hallucination", getHallucinationRunsHandler)
		api.GET("/benchmarks/hallucination/run", runHallucinationSSEHandler)
		api.DELETE("/benchmarks/hallucination/:id", deleteHallucinationRunHandler)

		// New functional benchmark types
		api.GET("/benchmarks/tool-use/run", runToolUseBenchmarkSSEHandler)
		api.GET("/benchmarks/json-output/run", runJSONOutputBenchmarkSSEHandler)
		api.GET("/benchmarks/instruction-follow/run", runInstructionFollowBenchmarkSSEHandler)
		// JSON capability probe
		api.POST("/models/probe-json", probeJSONHandler)

		api.GET("/node-models", nodeModelsHandler)

		// Hyperparameter Optimizer
		api.GET("/optimizer/runs", getOptimizerRunsHandler)
		api.GET("/optimizer/runs/grouped", getGroupedOptimizerRunsHandler)
		api.GET("/optimizer/run", runOptimizerSSEHandler)
		api.DELETE("/optimizer/runs/:id", deleteOptimizerRunHandler)

		// Document RAG Panel Endpoints
		api.POST("/rag/extract-pdf", extractPDFTextHandler)
		api.POST("/rag/upload-and-index", uploadAndIndexHandler)
		api.GET("/rag/documents", getRAGDocumentsHandler)
		api.POST("/rag/documents", uploadRAGDocumentHandler)
		api.POST("/rag/documents/:id/chunks", appendRAGChunksHandler)
		api.DELETE("/rag/documents/:id", deleteRAGDocumentHandler)
		api.PUT("/rag/documents/:id/collection", updateRAGDocumentCollectionHandler)
		api.POST("/rag/query", queryRAGSimilarityHandler)
		api.GET("/rag/collections", getRAGCollectionsHandler)

		// User preferences
		api.GET("/preferences", getPreferencesHandler)
		api.PUT("/preferences", setPreferenceHandler)
		api.DELETE("/preferences", clearPreferencesHandler)

		// Diagnostics
		api.GET("/diagnostics", diagnosticsHandler)

		// System — Ollama remote update
		api.POST("/system/ollama-update", ollamaUpdateSSEHandler)

		// System — SSH key store
		api.GET("/ssh-keys", listSSHKeysHandler)
		api.POST("/ssh-keys", addSSHKeyHandler)
		api.DELETE("/ssh-keys/:id", deleteSSHKeyHandler)

		// System — About, bulk-delete, backup/restore, activity, presets
		api.GET("/about", aboutHandler)
		api.GET("/ollama-latest", ollamaLatestHandler)
		api.GET("/ollama-release-notes", releaseNotesHandler)
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

	srv := &http.Server{
		Addr:              addr,
		Handler:           r,
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server failed to run: %v", err)
		}
	}()

	// Wait for interrupt signal to gracefully shut down the server
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM, syscall.SIGINT)
	<-quit

	log.Println("Shutting down server gracefully...")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("Server forced to shutdown: %v", err)
	}

	if DB != nil {
		log.Println("Closing database connection...")
		if err := DB.Close(); err != nil {
			log.Printf("Error closing database: %v", err)
		}
	}

	log.Println("Server exited cleanly.")
}

func resolvePort(flagPort int) (int, error) {
	if flagPort != 0 {
		if flagPort < 1 || flagPort > 65535 {
			return 0, fmt.Errorf("must be between 1 and 65535")
		}
		return flagPort, nil
	}
	rawPort := strings.TrimSpace(os.Getenv("PORT"))
	if rawPort == "" {
		return 8811, nil
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
	nodeStatusCache map[string]nodeCacheEntry

	nodeModelMu    sync.RWMutex
	nodeModelCache map[string]modelCacheEntry

	nodeRunningMu         sync.RWMutex
	nodeRunningCache      map[string][]string
	nodeActiveModelsCache map[string][]ProcessModel

	nodeAgentMu    sync.RWMutex
	nodeAgentCache map[string]*AgentMetricsResult
)

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
		default:
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
		if ramTotal, ramUsed, err := getMacRAM(); err == nil {
			stats.RAMTotal = ramTotal
			stats.RAMUsed = ramUsed
		}
		return stats
	}

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
				valBytes := val * 1024
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
				client := NewPollerClient(activeSrv)
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				models, err := client.ListActiveModels(ctx)
				cancel()
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

func startNodeCachePoller() {
	nodeStatusCache  = make(map[string]nodeCacheEntry)
	nodeModelCache   = make(map[string]modelCacheEntry)
	nodeRunningCache = make(map[string][]string)
	nodeActiveModelsCache = make(map[string][]ProcessModel)
	nodeAgentCache   = make(map[string]*AgentMetricsResult)

	go func() {
		pollAllNodeStatuses()
		pollAllNodeModels()
		pollAllNodeRunning()
		pollAllNodeAgents()

		statusTicker  := time.NewTicker(5 * time.Second)
		modelTicker   := time.NewTicker(60 * time.Second)
		runningTicker := time.NewTicker(15 * time.Second)
		agentTicker   := time.NewTicker(30 * time.Second)
		defer statusTicker.Stop()
		defer modelTicker.Stop()
		defer runningTicker.Stop()
		defer agentTicker.Stop()

		for {
			select {
			case <-statusTicker.C:
				pollAllNodeStatuses()
			case <-modelTicker.C:
				pollAllNodeModels()
			case <-runningTicker.C:
				pollAllNodeRunning()
			case <-agentTicker.C:
				pollAllNodeAgents()
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
	client := NewPollerClient(srv)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	version, latency, err := client.CheckStatus(ctx)
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

	if !hadOld || old.response.Status != status || old.response.Version != version {
		broadcastNodeStatus(entry.response)
	}
}

func pollAllNodeModels() {
	srvs := GetServers()
	var wg sync.WaitGroup
	for _, srv := range srvs {
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
	client := NewOllamaClient(srv)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	models, err := client.ListModels(ctx)
	if err != nil {
		return
	}
	nodeModelMu.Lock()
	nodeModelCache[srv.ID] = modelCacheEntry{models: models, updatedAt: time.Now()}
	nodeModelMu.Unlock()
}

func pollAllNodeRunning() {
	srvs := GetServers()
	var wg sync.WaitGroup
	for _, srv := range srvs {
		nodeStatusMu.RLock()
		entry, ok := nodeStatusCache[srv.ID]
		nodeStatusMu.RUnlock()
		if ok && entry.response.Status != "online" {
			continue
		}
		wg.Add(1)
		go func(s Server) {
			defer wg.Done()
			pollOneNodeRunning(s)
		}(srv)
	}
	wg.Wait()
}

func pollOneNodeRunning(srv Server) {
	client := NewPollerClient(srv)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	active, err := client.ListActiveModels(ctx)
	if err != nil {
		return
	}
	names := make([]string, 0, len(active))
	for _, m := range active {
		names = append(names, m.Name)
	}
	nodeRunningMu.Lock()
	nodeRunningCache[srv.ID] = names
	nodeActiveModelsCache[srv.ID] = active
	nodeRunningMu.Unlock()
}

type AgentMetricsResult struct {
	Hostname      string         `json:"hostname"`
	OS            string         `json:"os"`
	Arch          string         `json:"arch"`
	UptimeSeconds uint64         `json:"uptime_seconds"`
	CPU           AgentCPUInfo   `json:"cpu"`
	Memory        AgentMemInfo   `json:"memory"`
	GPUs          []AgentGPUInfo `json:"gpus"`
	AgentVersion  string         `json:"agent_version"`
}

type AgentCPUInfo struct {
	Model        string  `json:"model"`
	Cores        int     `json:"cores"`
	UsagePercent float64 `json:"usage_percent"`
}

type AgentMemInfo struct {
	TotalBytes     uint64 `json:"total_bytes"`
	UsedBytes      uint64 `json:"used_bytes"`
	AvailableBytes uint64 `json:"available_bytes"`
}

type AgentGPUInfo struct {
	Index          int    `json:"index"`
	Vendor         string `json:"vendor"`
	Name           string `json:"name"`
	VRAMTotalBytes int64  `json:"vram_total_bytes"`
	VRAMUsedBytes  int64  `json:"vram_used_bytes"`
	VRAMFreeBytes  int64  `json:"vram_free_bytes"`
	Integrated     bool   `json:"integrated"`
}

func pollAllNodeAgents() {
	srvs := GetServers()
	var wg sync.WaitGroup
	for _, srv := range srvs {
		if srv.AgentKey == "" {
			continue
		}
		wg.Add(1)
		go func(s Server) {
			defer wg.Done()
			pollOneNodeAgent(s)
		}(srv)
	}
	wg.Wait()
}

func pollOneNodeAgent(srv Server) {
	m, err := fetchAgentMetrics(srv)
	nodeAgentMu.Lock()
	if err != nil {
		delete(nodeAgentCache, srv.ID)
	} else {
		nodeAgentCache[srv.ID] = m
	}
	nodeAgentMu.Unlock()
}

func fetchAgentMetrics(srv Server) (*AgentMetricsResult, error) {
	u, err := url.Parse(srv.URL)
	if err != nil {
		return nil, err
	}
	port := srv.AgentPort
	if port == 0 {
		port = 11435
	}
	agentURL := fmt.Sprintf("https://%s:%d/metrics", u.Hostname(), port)

	tlsCfg := &tls.Config{
		InsecureSkipVerify: true,
	}
	if srv.AgentFingerprint != "" {
		wantFP := strings.ToLower(srv.AgentFingerprint)
		tlsCfg.VerifyPeerCertificate = func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
			if len(rawCerts) == 0 {
				return fmt.Errorf("no certificate presented")
			}
			h := sha256.Sum256(rawCerts[0])
			got := hex.EncodeToString(h[:])
			if got != wantFP {
				return fmt.Errorf("TLS fingerprint mismatch: got %s", got)
			}
			return nil
		}
	}

	client := &http.Client{
		Timeout:   5 * time.Second,
		Transport: &http.Transport{TLSClientConfig: tlsCfg},
	}

	req, err := http.NewRequest(http.MethodGet, agentURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+srv.AgentKey)

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("agent returned %d", resp.StatusCode)
	}

	var m AgentMetricsResult
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		return nil, err
	}
	return &m, nil
}

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

func runModelUpdatesCheck() {
	activeSrv, err := GetActiveServer()
	if err != nil {
		log.Printf("Scheduler: no active server selected: %v", err)
		return
	}

	client := NewOllamaClient(activeSrv)
	ctxList, cancelList := context.WithTimeout(context.Background(), 10*time.Second)
	models, err := client.ListModels(ctxList)
	cancelList()
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
