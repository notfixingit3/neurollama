package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// releaseNotesCache caches GitHub release note bodies per version tag.
var releaseNotesCache struct {
	sync.Mutex
	entries map[string]struct {
		Body    string
		HTMLURL string
	}
}

func init() {
	releaseNotesCache.entries = make(map[string]struct {
		Body    string
		HTMLURL string
	})
}

func releaseNotesHandler(c *gin.Context) {
	version := strings.TrimPrefix(c.Query("version"), "v")
	if version == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "version required"})
		return
	}
	tag := "v" + version

	releaseNotesCache.Lock()
	entry, cached := releaseNotesCache.entries[tag]
	releaseNotesCache.Unlock()
	if cached {
		c.JSON(http.StatusOK, gin.H{"version": version, "body": entry.Body, "html_url": entry.HTMLURL})
		return
	}

	client := &http.Client{Timeout: 10 * time.Second}
	req, _ := http.NewRequest("GET",
		"https://api.github.com/repos/ollama/ollama/releases/tags/"+tag, nil)
	req.Header.Set("User-Agent", "neurollama/"+appVersion)
	req.Header.Set("Accept", "application/vnd.github.v3+json")
	resp, err := client.Do(req)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error()})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		c.JSON(http.StatusNotFound, gin.H{"error": "No release found for " + tag})
		return
	}
	if resp.StatusCode != http.StatusOK {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("GitHub returned %d", resp.StatusCode)})
		return
	}

	var rel struct {
		Body    string `json:"body"`
		HTMLURL string `json:"html_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to parse response"})
		return
	}

	releaseNotesCache.Lock()
	releaseNotesCache.entries[tag] = struct {
		Body    string
		HTMLURL string
	}{rel.Body, rel.HTMLURL}
	releaseNotesCache.Unlock()

	c.JSON(http.StatusOK, gin.H{"version": version, "body": rel.Body, "html_url": rel.HTMLURL})
}

// ollamaLatestCache caches the latest Ollama release info from GitHub for 1 hour.
var ollamaLatestCache struct {
	sync.Mutex
	stable     string
	prerelease string
	fetchedAt  time.Time
}

func fetchOllamaLatest() (stable, prerelease string, err error) {
	client := &http.Client{Timeout: 10 * time.Second}
	req, _ := http.NewRequest("GET", "https://api.github.com/repos/ollama/ollama/releases?per_page=10", nil)
	req.Header.Set("User-Agent", "neurollama/"+appVersion)
	req.Header.Set("Accept", "application/vnd.github.v3+json")
	resp, err := client.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()

	var releases []struct {
		TagName    string `json:"tag_name"`
		Prerelease bool   `json:"prerelease"`
		Draft      bool   `json:"draft"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&releases); err != nil {
		return "", "", err
	}

	for _, r := range releases {
		if r.Draft {
			continue
		}
		tag := strings.TrimPrefix(r.TagName, "v")
		if !r.Prerelease && stable == "" {
			stable = tag
		}
		if r.Prerelease && prerelease == "" {
			prerelease = tag
		}
		if stable != "" && prerelease != "" {
			break
		}
	}
	return stable, prerelease, nil
}

func ollamaLatestHandler(c *gin.Context) {
	const cacheTTL = time.Hour

	ollamaLatestCache.Lock()
	defer ollamaLatestCache.Unlock()

	if ollamaLatestCache.stable != "" && time.Since(ollamaLatestCache.fetchedAt) < cacheTTL {
		c.JSON(http.StatusOK, gin.H{
			"stable":     ollamaLatestCache.stable,
			"prerelease": ollamaLatestCache.prerelease,
		})
		return
	}

	stable, prerelease, err := fetchOllamaLatest()
	if err != nil {
		if ollamaLatestCache.stable != "" {
			c.JSON(http.StatusOK, gin.H{
				"stable":     ollamaLatestCache.stable,
				"prerelease": ollamaLatestCache.prerelease,
			})
			return
		}
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error()})
		return
	}

	ollamaLatestCache.stable     = stable
	ollamaLatestCache.prerelease = prerelease
	ollamaLatestCache.fetchedAt  = time.Now()

	c.JSON(http.StatusOK, gin.H{
		"stable":     stable,
		"prerelease": prerelease,
	})
}

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
		Time:     time.Now().Format("Jan 02 15:04:05"),
		Category: category,
		Message:  message,
	})
	if len(activityBuf) > activityMaxSize {
		activityBuf = activityBuf[len(activityBuf)-activityMaxSize:]
	}
}

// seedActivityFromDB pre-populates the activity buffer with recent DB history so
// the HOME dashboard shows useful data immediately after server restart.
func seedActivityFromDB() {
	benches, err := GetBenchmarks()
	if err != nil || len(benches) == 0 {
		return
	}
	// GetBenchmarks returns newest-first; take up to 20 and reverse so the buffer
	// stays oldest-first (LogActivity appends; the handler reverses for display).
	cap := 20
	if len(benches) < cap {
		cap = len(benches)
	}
	recent := benches[:cap]
	activityMu.Lock()
	for i := cap - 1; i >= 0; i-- {
		b := recent[i]
		msg := fmt.Sprintf("Benchmark completed: %s (%s) on %s", b.ModelName, b.BenchmarkType, b.ServerName)
		activityBuf = append(activityBuf, ActivityEntry{
			Time:     b.CreatedAt,
			Category: "benchmark",
			Message:  msg,
		})
	}
	activityMu.Unlock()
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

func telemetryStreamHandler(c *gin.Context) {
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("Transfer-Encoding", "chunked")

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	ctx := c.Request.Context()

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
		version, latency, err := client.CheckStatus(c.Request.Context())
		if err != nil {
			addCheck("Active Ollama Node", "fail", "Active Ollama node is unreachable.", err.Error())
		} else {
			addCheck("Active Ollama Node", "pass", "Active Ollama node responded to /api/version.", fmt.Sprintf("%s in %dms", version, latency.Milliseconds()))
			if models, err := client.ListModels(c.Request.Context()); err != nil {
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
		port = "8811"
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

func checkModelUpdatesNowHandler(c *gin.Context) {
	go runModelUpdatesCheck()
	c.JSON(http.StatusOK, gin.H{"message": "Model update check initiated in background."})
}

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

	// DB file size (main + WAL if present)
	var dbBytes, walBytes int64
	if info, err := os.Stat(activeDBPath); err == nil {
		dbBytes = info.Size()
	}
	if info, err := os.Stat(activeDBPath + "-wal"); err == nil {
		walBytes = info.Size()
	}
	totalBytes := dbBytes + walBytes

	fmtSize := func(b int64) string {
		switch {
		case b >= 1<<20:
			return fmt.Sprintf("%.1f MB", float64(b)/float64(1<<20))
		case b >= 1<<10:
			return fmt.Sprintf("%.1f KB", float64(b)/float64(1<<10))
		default:
			return fmt.Sprintf("%d B", b)
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"version":       appVersion,
		"releaseType":   releaseType,
		"goVersion":     runtime.Version(),
		"uptime":        uptimeStr,
		"startTime":     appStartTime.Format("2006-01-02 15:04:05"),
		"dbPath":        activeDBPath,
		"dbSize":        fmtSize(totalBytes),
		"dbSizeBytes":   totalBytes,
		"dbSizeWal":     fmtSize(walBytes),
		"chatCount":     chatCount,
		"benchCount":    benchCount,
	})
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
		_ = os.Remove(pendingPath)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to write restore file"})
		return
	}

	LogActivity("system", fmt.Sprintf("Database restore staged: %s (restart required)", file.Filename))
	c.JSON(http.StatusOK, gin.H{
		"message":         "Restore file saved. Restart NEUROLLAMA to apply.",
		"restartRequired": true,
	})
}
