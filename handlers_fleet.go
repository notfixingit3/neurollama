package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	gossh "golang.org/x/crypto/ssh"
	sshagent "golang.org/x/crypto/ssh/agent"
)

// NodeOverviewEntry is one row in the fleet overview — aggregated from cache only.
type NodeOverviewEntry struct {
	ID             string               `json:"id"`
	Name           string               `json:"name"`
	URL            string               `json:"url"`
	Status         string               `json:"status"`
	Version        string               `json:"version"`
	LatencyMs      int64                `json:"latency_ms"`
	ModelCount     int                  `json:"model_count"`
	RunningModels  []string             `json:"running_models"`
	ActiveModels   []ProcessModel       `json:"active_models"`
	VramGB         float64              `json:"vram_gb"`
	AgentMetrics   *AgentMetricsResult  `json:"agent_metrics,omitempty"`
	CacheUpdatedAt int64                `json:"cache_updated_at"` // unix seconds; 0 = not yet polled
}

// nodesOverviewHandler returns every node's cached status + model count in one call.
// GET /api/nodes/overview
func nodesOverviewHandler(c *gin.Context) {
	srvs := GetServers()
	entries := make([]NodeOverviewEntry, 0, len(srvs))

	nodeStatusMu.RLock()
	for _, srv := range srvs {
		e := NodeOverviewEntry{ID: srv.ID, Name: srv.Name, URL: srv.URL, VramGB: srv.VramGB}
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

	nodeRunningMu.RLock()
	for i, e := range entries {
		if running, ok := nodeRunningCache[e.ID]; ok {
			entries[i].RunningModels = running
		}
		if active, ok := nodeActiveModelsCache[e.ID]; ok {
			entries[i].ActiveModels = active
		}
	}
	nodeRunningMu.RUnlock()

	nodeAgentMu.RLock()
	for i, e := range entries {
		if m, ok := nodeAgentCache[e.ID]; ok {
			entries[i].AgentMetrics = m
		}
	}
	nodeAgentMu.RUnlock()

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

	// Drop stale entries then re-poll synchronously (3s timeout via NewPollerClient).
	nodeStatusMu.Lock()
	delete(nodeStatusCache, id)
	nodeStatusMu.Unlock()
	nodeRunningMu.Lock()
	delete(nodeRunningCache, id)
	nodeRunningMu.Unlock()

	nodeAgentMu.Lock()
	delete(nodeAgentCache, id)
	nodeAgentMu.Unlock()

	pollOneNodeStatus(*found)
	go pollOneNodeRunning(*found)
	go pollOneNodeAgent(*found)

	nodeStatusMu.RLock()
	entry := nodeStatusCache[id]
	nodeStatusMu.RUnlock()

	c.JSON(http.StatusOK, entry.response)
}

// POST /api/nodes/:id/unload
type UnloadModelRequest struct {
	Model string `json:"model" binding:"required"`
}

func unloadNodeModelHandler(c *gin.Context) {
	id := c.Param("id")
	var req UnloadModelRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

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

	client := NewOllamaClient(*found)
	if err := client.UnloadModel(c.Request.Context(), req.Model); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("failed to unload model: %v", err)})
		return
	}

	// Trigger background re-poll immediately so the cache stays in sync
	go func() {
		pollOneNodeRunning(*found)
		// Get fresh cache entry and broadcast it
		nodeStatusMu.RLock()
		if se, ok := nodeStatusCache[found.ID]; ok {
			broadcastNodeStatus(se.response)
		}
		nodeStatusMu.RUnlock()
	}()

	LogActivity("node", fmt.Sprintf("Unloaded model %s on node %s", req.Model, found.Name))
	c.JSON(http.StatusOK, gin.H{"message": fmt.Sprintf("Model %s unloaded successfully", req.Model)})
}

// POST /api/nodes/:id/agent-test — checks connectivity and auth against a node's neuro-agent.
func testNodeAgentHandler(c *gin.Context) {
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
	if found.AgentKey == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no agent key configured for this node"})
		return
	}
	m, err := fetchAgentMetrics(*found)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"status":        "ok",
		"hostname":      m.Hostname,
		"agent_version": m.AgentVersion,
		"os":            m.OS,
		"arch":          m.Arch,
	})
}

// ── neuro-agent SSH deploy ────────────────────────────────────────────────────

type AgentDeployRequest struct {
	SSHUser     string `json:"ssh_user"`
	SSHPassword string `json:"ssh_password"`
	SudoPass    string `json:"sudo_password"`
	UseSSHKey   bool   `json:"use_ssh_key"`
	SSHPort     int    `json:"ssh_port"`
	SSHKeyID    string `json:"ssh_key_id"`
	AgentPort   int    `json:"agent_port"` // defaults to 11435
}

func agentDeploySSEHandler(c *gin.Context) {
	nodeID := c.Param("id")
	var req AgentDeployRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	if req.SSHUser == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ssh_user is required"})
		return
	}
	if req.AgentPort == 0 {
		req.AgentPort = 11435
	}

	var targetSrv *Server
	for _, s := range GetServers() {
		s := s
		if s.ID == nodeID {
			targetSrv = &s
			break
		}
	}
	if targetSrv == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "server not found"})
		return
	}

	parsedURL, err := url.Parse(targetSrv.URL)
	if err != nil || parsedURL.Hostname() == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot parse hostname from server URL"})
		return
	}
	host := parsedURL.Hostname()
	sshPort := 22
	if req.SSHPort > 0 {
		sshPort = req.SSHPort
	}

	authMethods := buildSSHAuthMethods(req.SSHKeyID, req.SSHPassword, req.UseSSHKey)
	if len(authMethods) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no SSH auth method available"})
		return
	}

	sshCfg := &gossh.ClientConfig{
		User:            req.SSHUser,
		Auth:            authMethods,
		HostKeyCallback: gossh.InsecureIgnoreHostKey(), // #nosec G106
		Timeout:         15 * time.Second,
	}

	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("Transfer-Encoding", "chunked")

	c.Stream(func(w io.Writer) bool {
		emit := func(event, msg string) { c.SSEvent(event, msg); c.Writer.Flush() }
		line := func(msg string) { emit("output", msg) }
		fail := func(msg string) { emit("error", msg); emit("done", "failed") }
		sudo := func(cmd string) string {
			if req.SudoPass != "" {
				return fmt.Sprintf("echo %s | sudo -S sh -c %s", shellEscapeSingle(req.SudoPass), shellEscapeSingle(cmd))
			}
			return "sudo sh -c " + shellEscapeSingle(cmd)
		}

		// ── Connect ──────────────────────────────────────────────────────────
		emit("status", fmt.Sprintf("Connecting to %s@%s:%d…", req.SSHUser, host, sshPort))
		rawClient, connErr := gossh.Dial("tcp", fmt.Sprintf("%s:%d", host, sshPort), sshCfg)
		if connErr != nil {
			fail(fmt.Sprintf("SSH connection failed: %v", connErr))
			return false
		}
		sshClient := &sshClientWrapper{client: rawClient, ctx: c.Request.Context()}
		defer sshClient.Close()

		// ── Detect OS / arch ─────────────────────────────────────────────────
		osStr, _   := runSSHCmd(sshClient, "uname -s")
		archRaw, _ := runSSHCmd(sshClient, "uname -m")
		osStr = strings.ToLower(strings.TrimSpace(osStr))
		var goarch string
		switch strings.TrimSpace(archRaw) {
		case "x86_64":
			goarch = "amd64"
		case "aarch64", "arm64":
			goarch = "arm64"
		default:
			fail(fmt.Sprintf("unsupported arch: %s", archRaw))
			return false
		}
		var goos string
		switch {
		case strings.Contains(osStr, "linux"):
			goos = "linux"
		case strings.Contains(osStr, "darwin"):
			goos = "darwin"
		default:
			fail(fmt.Sprintf("unsupported OS: %s", osStr))
			return false
		}
		line(fmt.Sprintf("✔ Detected %s/%s", goos, goarch))

		// ── Cross-compile ─────────────────────────────────────────────────────
		binPath := filepath.Join(os.TempDir(), fmt.Sprintf("neuro-agent-%s-%s", goos, goarch))
		line(fmt.Sprintf("Building neuro-agent for %s/%s…", goos, goarch))
		buildCmd := exec.Command("go", "build", "-o", binPath, "./neuro-agent/")
		buildCmd.Env = append(os.Environ(),
			"GOOS="+goos,
			"GOARCH="+goarch,
			"CGO_ENABLED=0",
		)
		if out, buildErr := buildCmd.CombinedOutput(); buildErr != nil {
			fail(fmt.Sprintf("build failed: %s", strings.TrimSpace(string(out))))
			return false
		}
		defer os.Remove(binPath)
		line("✔ Binary built")

		// ── Upload binary via SSH stdin pipe ──────────────────────────────────
		line("Uploading binary…")
		binData, readErr := os.ReadFile(binPath) // #nosec G304 -- path built from os.TempDir() + fixed filename
		if readErr != nil {
			fail(fmt.Sprintf("cannot read binary: %v", readErr))
			return false
		}
		sess, sessErr := sshClient.NewSession()
		if sessErr != nil {
			fail(fmt.Sprintf("SSH session: %v", sessErr))
			return false
		}
		sess.Stdin = bytes.NewReader(binData)
		if uploadErr := sess.Run("cat > /tmp/neuro-agent && chmod +x /tmp/neuro-agent"); uploadErr != nil {
			sess.Close()
			fail(fmt.Sprintf("upload failed: %v", uploadErr))
			return false
		}
		sess.Close()
		line(fmt.Sprintf("✔ Uploaded (%d KB)", len(binData)/1024))

		// ── Install binary ────────────────────────────────────────────────────
		installCmd := sudo("mv /tmp/neuro-agent /usr/local/bin/neuro-agent && chmod 755 /usr/local/bin/neuro-agent")
		if _, installErr := runSSHCmd(sshClient, installCmd); installErr != nil {
			fail(fmt.Sprintf("install failed: %v", installErr))
			return false
		}
		line("✔ Installed to /usr/local/bin/neuro-agent")

		// ── Install + start service ───────────────────────────────────────────
		portStr := strconv.Itoa(req.AgentPort)
		switch goos {
		case "linux":
			unitContent := fmt.Sprintf(`[Unit]
Description=NEUROLLAMA Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=%s
ExecStart=/usr/local/bin/neuro-agent --port %s
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`, req.SSHUser, portStr)
			unitB64 := base64.StdEncoding.EncodeToString([]byte(unitContent))
			writeUnit := sudo(fmt.Sprintf("echo %s | base64 -d > /etc/systemd/system/neuro-agent.service", unitB64))
			if _, unitErr := runSSHCmd(sshClient, writeUnit); unitErr != nil {
				fail(fmt.Sprintf("service file write failed: %v", unitErr))
				return false
			}
			enableCmd := sudo("systemctl daemon-reload && systemctl enable neuro-agent && systemctl restart neuro-agent")
			if out, startErr := runSSHCmd(sshClient, enableCmd); startErr != nil {
				fail(fmt.Sprintf("service start failed: %s", out))
				return false
			}
			line("✔ systemd service enabled and started")

		case "darwin":
			// Get the real HOME so we can embed it in the plist and use full paths.
			homeDir, homeErr := runSSHCmd(sshClient, "echo $HOME")
			if homeErr != nil || strings.TrimSpace(homeDir) == "" {
				fail("cannot determine HOME directory on remote host")
				return false
			}
			homeDir = strings.TrimSpace(homeDir)

			// Strip Gatekeeper quarantine so launchd can execute the unsigned binary.
			_, _ = runSSHCmd(sshClient, "xattr -d com.apple.quarantine /usr/local/bin/neuro-agent 2>/dev/null")

			plistLabel   := "com.neurollama.agent"
			plistFullDir := homeDir + "/Library/LaunchAgents"
			plistPath    := plistFullDir + "/" + plistLabel + ".plist"
			plistContent := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>%s</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/neuro-agent</string>
    <string>--port</string><string>%s</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>%s</string>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/neuro-agent.log</string>
  <key>StandardErrorPath</key><string>/tmp/neuro-agent.log</string>
</dict>
</plist>
`, plistLabel, portStr, homeDir)
			plistB64  := base64.StdEncoding.EncodeToString([]byte(plistContent))
			writePlist := fmt.Sprintf("mkdir -p %s && echo %s | base64 -d > %s",
				plistFullDir, plistB64, plistPath)
			if _, plistErr := runSSHCmd(sshClient, writePlist); plistErr != nil {
				fail(fmt.Sprintf("plist write failed: %v", plistErr))
				return false
			}
			// Try bootstrap/bootout (modern, requires active GUI session).
			uid, _ := runSSHCmd(sshClient, "id -u")
			uid = strings.TrimSpace(uid)
			domain := "gui/" + uid
			_, _ = runSSHCmd(sshClient, fmt.Sprintf(
				"launchctl bootout %s %s 2>/dev/null; launchctl bootstrap %s %s 2>/dev/null",
				domain, plistPath, domain, plistPath))

			// Wait briefly then check if launchd actually started the process.
			time.Sleep(2 * time.Second)
			launchctlOut, _ := runSSHCmd(sshClient, fmt.Sprintf("launchctl list %s 2>/dev/null", plistLabel))
			agentRunning := strings.Contains(launchctlOut, `"PID"`)

			if !agentRunning {
				// launchd bootstrap didn't start the process (SSH session may not have
				// access to the GUI domain). Run the agent directly in the background;
				// the LaunchAgent plist still provides persistence at next login.
				line("⚠ LaunchAgent not started via launchd — running agent directly…")
				_, _ = runSSHCmd(sshClient, fmt.Sprintf(
					"pkill neuro-agent 2>/dev/null; nohup /usr/local/bin/neuro-agent --port %s >>/tmp/neuro-agent.log 2>&1 &",
					portStr))
			}
			line("✔ LaunchAgent installed; agent running")
		}

		// ── Wait for agent to initialise its config ───────────────────────────
		line("Waiting for agent to initialise…")
		var agentInfoJSON string
		cfgPath := "~/.config/neuro-agent/info.json"
		for i := 0; i < 15; i++ {
			time.Sleep(time.Second)
			if out, err := runSSHCmd(sshClient, "cat "+cfgPath+" 2>/dev/null"); err == nil && strings.Contains(out, "api_key") {
				agentInfoJSON = out
				break
			}
		}
		if agentInfoJSON == "" {
			logTail, _ := runSSHCmd(sshClient, "tail -20 /tmp/neuro-agent.log 2>/dev/null")
			if strings.TrimSpace(logTail) != "" {
				for _, l := range strings.Split(strings.TrimSpace(logTail), "\n") {
					line("  " + l)
				}
			}
			fail("agent started but info.json not found — see log lines above")
			return false
		}

		// ── Parse and emit credentials ────────────────────────────────────────
		var info struct {
			APIKey      string `json:"api_key"`
			Fingerprint string `json:"fingerprint"`
			Port        int    `json:"port"`
		}
		if jsonErr := json.Unmarshal([]byte(agentInfoJSON), &info); jsonErr != nil {
			fail(fmt.Sprintf("cannot parse agent info: %v", jsonErr))
			return false
		}

		line("✔ Agent running")
		line(fmt.Sprintf("  API Key:         %s", info.APIKey))
		line(fmt.Sprintf("  TLS Fingerprint: %s", info.Fingerprint))
		line(fmt.Sprintf("  Port:            %d", info.Port))

		// Emit credentials as structured event so the UI can pre-fill the node modal
		credJSON, _ := json.Marshal(map[string]interface{}{
			"server_id":    nodeID,
			"api_key":      info.APIKey,
			"fingerprint":  info.Fingerprint,
			"port":         info.Port,
			"ssh_user":     req.SSHUser,
			"ssh_key_id":   req.SSHKeyID,
			"ssh_port":     req.SSHPort,
		})
		emit("agent-credentials", string(credJSON))
		emit("done", "success")
		return false
	})
}

// ── Ollama Remote Update via SSH ──────────────────────────────────────────────

type OllamaUpdateRequest struct {
	ServerID    string `json:"server_id"`
	SSHUser     string `json:"ssh_user"`
	SSHPassword string `json:"ssh_password"`
	SudoPass    string `json:"sudo_password"`
	UseSSHKey   bool   `json:"use_ssh_key"`
	SSHPort     int    `json:"ssh_port"`
	SSHKeyID    string `json:"ssh_key_id"` // stored DB key; takes priority over agent/files
}

func ollamaUpdateSSEHandler(c *gin.Context) {
	var req OllamaUpdateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}
	if req.ServerID == "" || req.SSHUser == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "server_id and ssh_user are required"})
		return
	}

	// Resolve target server
	var targetSrv *Server
	for _, s := range GetServers() {
		s := s
		if s.ID == req.ServerID {
			targetSrv = &s
			break
		}
	}
	if targetSrv == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Server not found"})
		return
	}

	// Extract hostname from server URL
	parsedURL, err := url.Parse(targetSrv.URL)
	if err != nil || parsedURL.Hostname() == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Cannot parse hostname from server URL"})
		return
	}
	host := parsedURL.Hostname()
	sshPort := 22
	if req.SSHPort > 0 {
		sshPort = req.SSHPort
	}

	// Build SSH auth methods
	var authMethods []gossh.AuthMethod

	// Priority 1: specific stored DB key selected in the UI
	if req.SSHKeyID != "" {
		if pem, keyErr := GetSSHKeyPEMByID(req.SSHKeyID); keyErr == nil {
			if signer, parseErr := gossh.ParsePrivateKey(pem); parseErr == nil {
				authMethods = append(authMethods, gossh.PublicKeys(signer))
			}
		}
	}

	if req.UseSSHKey || req.SSHPassword == "" {
		// Priority 2: SSH agent (handles passphrase-protected keys already unlocked)
		if agentSock := os.Getenv("SSH_AUTH_SOCK"); agentSock != "" {
			if conn, dialErr := net.Dial("unix", agentSock); dialErr == nil { // #nosec G704
				authMethods = append(authMethods, gossh.PublicKeysCallback(sshagent.NewClient(conn).Signers))
			}
		}
		// Priority 3: unencrypted key files in ~/.ssh/
		homeDir, _ := os.UserHomeDir()
		for _, kf := range []string{
			filepath.Join(homeDir, ".ssh", "id_ed25519"),
			filepath.Join(homeDir, ".ssh", "id_ecdsa"),
			filepath.Join(homeDir, ".ssh", "id_rsa"),
		} {
			if raw, readErr := os.ReadFile(kf); readErr == nil { // #nosec G304
				if signer, parseErr := gossh.ParsePrivateKey(raw); parseErr == nil {
					authMethods = append(authMethods, gossh.PublicKeys(signer))
				}
			}
		}
		// Priority 4: all stored DB keys (Docker / no-agent fallback)
		if req.SSHKeyID == "" {
			if pems, dbErr := GetSSHKeyPEMs(); dbErr == nil {
				for _, pem := range pems {
					if signer, parseErr := gossh.ParsePrivateKey(pem); parseErr == nil {
						authMethods = append(authMethods, gossh.PublicKeys(signer))
					}
				}
			}
		}
	}
	if req.SSHPassword != "" {
		authMethods = append(authMethods, gossh.Password(req.SSHPassword))
		authMethods = append(authMethods, gossh.KeyboardInteractive(func(_, _ string, questions []string, _ []bool) ([]string, error) {
			answers := make([]string, len(questions))
			for i := range answers {
				answers[i] = req.SSHPassword
			}
			return answers, nil
		}))
	}
	if len(authMethods) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No SSH auth method available — provide a password or ensure an SSH key exists in ~/.ssh/"})
		return
	}

	sshCfg := &gossh.ClientConfig{
		User:            req.SSHUser,
		Auth:            authMethods,
		HostKeyCallback: gossh.InsecureIgnoreHostKey(), // #nosec G106
		Timeout:         15 * time.Second,
	}

	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("Transfer-Encoding", "chunked")

	c.Stream(func(w io.Writer) bool {
		emit := func(event, msg string) { c.SSEvent(event, msg); c.Writer.Flush() }
		line := func(msg string) { emit("output", msg) }
		fail := func(msg string) { emit("error", msg); emit("done", "failed") }

		// check emits a structured pre-flight result and tracks fatal failures.
		preflightFailed := false
		check := func(name string, passed, fatal bool, detail string) {
			b, _ := json.Marshal(map[string]interface{}{
				"name": name, "passed": passed, "fatal": fatal, "detail": detail,
			})
			emit("check", string(b))
			if !passed && fatal {
				preflightFailed = true
			}
		}

		// ── Connect ───────────────────────────────────────────────────────────
		emit("status", fmt.Sprintf("Connecting to %s@%s:%d…", req.SSHUser, host, sshPort))
		rawClient, connErr := gossh.Dial("tcp", fmt.Sprintf("%s:%d", host, sshPort), sshCfg)
		if connErr != nil {
			fail(fmt.Sprintf("SSH connection failed: %v", connErr))
			return false
		}
		sshClient := &sshClientWrapper{client: rawClient, ctx: c.Request.Context()}
		defer sshClient.Close()
		emit("status", "SSH connected.")

		osStr, _ := runSSHCmd(sshClient, "uname -s")
		archRaw, _ := runSSHCmd(sshClient, "uname -m")
		emit("status", fmt.Sprintf("Remote: OS=%s arch=%s — running pre-flight checks…", osStr, archRaw))

		// ── Pre-flight: common ────────────────────────────────────────────────
		curlVer, curlOK := sshCheckStr(sshClient, "curl --version 2>/dev/null | head -1", "", "curl not found — required for download")
		check("curl available", curlOK, true, curlVer)

		_, apiOK := sshCheckStr(sshClient, "curl -fsSL --connect-timeout 8 -o /dev/null https://api.github.com/repos/ollama/ollama/releases/latest",
			"api.github.com reachable", "cannot reach GitHub API from this host")
		check("GitHub API reachable", apiOK, true, "")

		// ── Pre-flight: OS-specific ───────────────────────────────────────────
		var currentVer, ollamaPath string

		switch osStr {
		case "Darwin":
			_, dittoOK := sshCheckStr(sshClient, "command -v ditto", "ditto found", "ditto not found")
			check("ditto available", dittoOK, true, "")

			_, openOK := sshCheckStr(sshClient, "command -v open", "open found", "open not found")
			check("open command", openOK, true, "")

			_, appOK := sshCheckStr(sshClient, "test -d /Applications/Ollama.app", "/Applications/Ollama.app exists", "Ollama.app not found at expected location")
			check("Ollama.app exists", appOK, true, "")

			_, writeOK := sshCheckStr(sshClient,
				"touch /Applications/.ollama-write-test && rm /Applications/.ollama-write-test",
				"write access confirmed", "cannot write to /Applications/ — permission denied")
			check("/Applications/ writable", writeOK, true, "")

			dfOut, _ := runSSHCmd(sshClient, "df -k /tmp 2>/dev/null | awk 'NR==2{print $4}' || echo 0")
			dfKB, _ := strconv.ParseInt(strings.TrimSpace(dfOut), 10, 64)
			check("disk space (/tmp)", dfKB >= 409600, true,
				fmt.Sprintf("%.0f MB free (need ≥400 MB for Ollama-darwin.zip)", float64(dfKB)/1024))

			currentVer, _ = runSSHCmd(sshClient,
				"defaults read /Applications/Ollama.app/Contents/Info.plist CFBundleShortVersionString 2>/dev/null || echo unknown")
			check("current version", true, false, currentVer)

		case "Linux":
			_, sysOK := sshCheckStr(sshClient, "command -v systemctl", "systemctl found", "systemctl not found — cannot manage service")
			check("systemd available", sysOK, true, "")

			ollamaPath, _ = runSSHCmd(sshClient, "command -v ollama 2>/dev/null || echo ''")
			check("Ollama binary", ollamaPath != "", true,
				func() string {
					if ollamaPath != "" {
						return "found at " + ollamaPath
					}
					return "ollama binary not found in PATH"
				}())

			_, svcOK := sshCheckStr(sshClient, "test -f /etc/systemd/system/ollama.service",
				"/etc/systemd/system/ollama.service exists",
				"service file missing — may have been removed by an OS update")
			check("systemd service file", svcOK, true, "")

			enabledOut, _ := runSSHCmd(sshClient, "systemctl is-enabled ollama 2>/dev/null || echo disabled")
			check("service enabled", strings.TrimSpace(enabledOut) == "enabled", false,
				func() string {
					if strings.TrimSpace(enabledOut) == "enabled" {
						return "enabled"
					}
					return "not enabled — will not auto-start on reboot (warning only)"
				}())

			esc := shellEscapeSingle(req.SudoPass)
			_, sudoOK := sshCheckStr(sshClient,
				fmt.Sprintf("echo %s | sudo -S -p '' true", esc),
				"sudo credentials valid", "sudo authentication failed — wrong password?")
			check("sudo credentials", sudoOK, true, "")

			dfOut, _ := runSSHCmd(sshClient, "df -k /tmp 2>/dev/null | awk 'NR==2{print $4}' || echo 0")
			dfKB, _ := strconv.ParseInt(strings.TrimSpace(dfOut), 10, 64)
			check("disk space (/tmp)", dfKB >= 102400, true,
				fmt.Sprintf("%.0f MB free (need ≥100 MB)", float64(dfKB)/1024))

			currentVer, _ = runSSHCmd(sshClient, "ollama --version 2>/dev/null || echo unknown")
			check("current version", true, false, currentVer)

		default:
			fail(fmt.Sprintf("Unsupported OS: %q", osStr))
			return false
		}

		// ── Abort if any fatal check failed ───────────────────────────────────
		if preflightFailed {
			fail("Pre-flight checks failed — update aborted. Fix the issues above and retry.")
			return false
		}
		emit("status", "All pre-flight checks passed. Starting update…")

		// ── Update ────────────────────────────────────────────────────────────
		emit("status", "Fetching latest Ollama version from GitHub…")
		ver, _ := runSSHCmd(sshClient,
			`curl -fsSL https://api.github.com/repos/ollama/ollama/releases/latest 2>/dev/null | sed -n 's/.*"tag_name" *: *"\([^"]*\)".*/\1/p' | head -1`)
		if ver == "" {
			fail("Could not fetch latest version tag — GitHub API returned empty response")
			return false
		}
		emit("status", fmt.Sprintf("Latest release: %s", ver))

		switch osStr {
		case "Darwin":
			appExists, _ := runSSHCmd(sshClient, "test -d /Applications/Ollama.app && echo yes || echo no")
			if strings.TrimSpace(appExists) == "yes" {
				dlURL := fmt.Sprintf("https://github.com/ollama/ollama/releases/download/%s/Ollama-darwin.zip", ver)
				emit("status", fmt.Sprintf("Downloading Ollama-darwin.zip (≈177 MB)…"))
				if dErr := runSSHCmdStream(sshClient,
					fmt.Sprintf("curl -fsSL %s -o /tmp/Ollama-darwin.zip", dlURL), line); dErr != nil {
					fail(fmt.Sprintf("Download failed: %v", dErr))
					return false
				}
				emit("status", "Stopping Ollama…")
				_, _ = runSSHCmd(sshClient, `
OLLAMA_PID=$(pgrep -x ollama 2>/dev/null | head -1)
if [ -n "$OLLAMA_PID" ]; then
  ps ewwp "$OLLAMA_PID" 2>/dev/null | tr ' ' '\n' | grep '^OLLAMA_' > /tmp/ollama-env-snapshot.txt
fi
PLIST=""
for p in ~/Library/LaunchAgents/com.ollama.plist ~/Library/LaunchAgents/com.ollama.ollama.plist ~/Library/LaunchAgents/com.ollama.serve.plist; do
  [ -f "$p" ] && PLIST="$p" && break
done
[ -n "$PLIST" ] && launchctl unload "$PLIST" 2>/dev/null
killall -q Ollama ollama 2>/dev/null
sleep 1`)
				emit("status", "Replacing Ollama.app…")
				replaceCmd := `set -e
rm -rf /tmp/ollama-update-tmp
mkdir /tmp/ollama-update-tmp
ditto -xk /tmp/Ollama-darwin.zip /tmp/ollama-update-tmp/
rm -rf /Applications/Ollama.app
ditto /tmp/ollama-update-tmp/Ollama.app /Applications/Ollama.app
xattr -dr com.apple.quarantine /Applications/Ollama.app 2>/dev/null || true
rm -rf /tmp/ollama-update-tmp /tmp/Ollama-darwin.zip`
				if rErr := runSSHCmdStream(sshClient, replaceCmd, line); rErr != nil {
					fail(fmt.Sprintf("App replacement failed: %v", rErr))
					return false
				}
				emit("status", "Restarting Ollama…")
				_, _ = runSSHCmd(sshClient, `
PLIST=""
for p in ~/Library/LaunchAgents/com.ollama.plist ~/Library/LaunchAgents/com.ollama.ollama.plist ~/Library/LaunchAgents/com.ollama.serve.plist; do
  [ -f "$p" ] && PLIST="$p" && break
done
SAVED_VARS=$(cat /tmp/ollama-env-snapshot.txt 2>/dev/null | xargs)
rm -f /tmp/ollama-env-snapshot.txt
if [ -n "$PLIST" ]; then
  /usr/libexec/PlistBuddy -c "Delete :ProgramArguments" "$PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :ProgramArguments array" "$PLIST"
  /usr/libexec/PlistBuddy -c "Add :ProgramArguments:0 string /Applications/Ollama.app/Contents/Resources/ollama" "$PLIST"
  /usr/libexec/PlistBuddy -c "Add :ProgramArguments:1 string serve" "$PLIST"
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables dict" "$PLIST" 2>/dev/null || true
  for kv in $SAVED_VARS; do
    KEY="${kv%%=*}"; VAL="${kv#*=}"
    /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:${KEY} ${VAL}" "$PLIST" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:${KEY} string ${VAL}" "$PLIST" 2>/dev/null || true
  done
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:OLLAMA_HOST 0.0.0.0" "$PLIST" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:OLLAMA_HOST string 0.0.0.0" "$PLIST"
  launchctl load "$PLIST"
  sleep 2
  if ! pgrep -x ollama >/dev/null 2>&1; then
    ENV_ARGS="OLLAMA_HOST=0.0.0.0"
    for kv in $SAVED_VARS; do
      case "$kv" in OLLAMA_HOST=*) ;; OLLAMA_*) ENV_ARGS="$ENV_ARGS $kv" ;; esac
    done
    nohup env $ENV_ARGS /Applications/Ollama.app/Contents/Resources/ollama serve >/tmp/ollama-serve.log 2>&1 &
    echo "⚠ LaunchAgent did not activate over SSH (no GUI session) — started via nohup. The plist is correctly written and will take over on next GUI login."
  fi
else
  ENV_ARGS="OLLAMA_HOST=0.0.0.0"
  for kv in $SAVED_VARS; do
    case "$kv" in
      OLLAMA_HOST=*) ;;
      OLLAMA_*) ENV_ARGS="$ENV_ARGS $kv" ;;
    esac
  done
  nohup env $ENV_ARGS /Applications/Ollama.app/Contents/Resources/ollama serve >/tmp/ollama-serve.log 2>&1 &
fi`)
			} else {
				emit("status", "CLI install — running Ollama install script…")
				if sErr := runSSHCmdStream(sshClient, "curl -fsSL https://ollama.com/install.sh | sh", line); sErr != nil {
					fail(fmt.Sprintf("macOS CLI update failed: %v", sErr))
					return false
				}
			}

		case "Linux":
			esc := shellEscapeSingle(req.SudoPass)
			sudo := func(cmd string) string {
				return fmt.Sprintf("echo %s | sudo -S -p '' %s", esc, cmd)
			}

			const svcPath = "/etc/systemd/system/ollama.service"
			const svcBackup = "/tmp/ollama.service.neurollama.bak"

			emit("status", "Backing up custom service file…")
			if bErr := runSSHCmdStream(sshClient,
				sudo(fmt.Sprintf("cp %s %s", svcPath, svcBackup)), line); bErr != nil {
				fail(fmt.Sprintf("Could not backup service file: %v", bErr))
				return false
			}

			emit("status", "Stopping ollama.service…")
			if sErr := runSSHCmdStream(sshClient, sudo("systemctl stop ollama"), line); sErr != nil {
				line(fmt.Sprintf("  (stop warning: %v — continuing)", sErr))
			}

			emit("status", "Running Ollama installer (downloads ≈1.4 GB — may take a few minutes)…")
			installCmd := sudo("sh -c 'curl -fsSL https://ollama.com/install.sh | sh'")
			if iErr := runSSHCmdStream(sshClient, installCmd, line); iErr != nil {
				fail(fmt.Sprintf("Installer failed: %v", iErr))
				return false
			}

			_, _ = runSSHCmd(sshClient, sudo("systemctl stop ollama"))

			emit("status", "Restoring custom service file…")
			restoreCmd := sudo(fmt.Sprintf(`sh -c 'cp %s %s && grep -q "^\[Unit\]" %s || { tmp=$(mktemp); printf "[Unit]\n" > "$tmp"; cat %s >> "$tmp"; mv "$tmp" %s; } && systemctl daemon-reload'`, svcBackup, svcPath, svcPath, svcPath, svcPath))
			if rErr := runSSHCmdStream(sshClient, restoreCmd, line); rErr != nil {
				fail(fmt.Sprintf("Failed to restore custom service file: %v", rErr))
				return false
			}
			_, _ = runSSHCmd(sshClient, fmt.Sprintf("rm -f %s", svcBackup))

			emit("status", "Starting ollama.service with custom configuration…")
			if sErr := runSSHCmdStream(sshClient, sudo("systemctl start ollama"), line); sErr != nil {
				fail(fmt.Sprintf("Service start failed: %v", sErr))
				return false
			}
		}

		// ── Verify ────────────────────────────────────────────────────────────
		var newVer string
		if osStr == "Darwin" {
			newVer, _ = runSSHCmd(sshClient,
				"defaults read /Applications/Ollama.app/Contents/Info.plist CFBundleShortVersionString 2>/dev/null || echo unknown")
		} else {
			newVer, _ = runSSHCmd(sshClient, "ollama --version 2>/dev/null || echo unknown")
		}
		if newVer != "" && newVer != currentVer {
			emit("status", fmt.Sprintf("Version: %s → %s ✔", currentVer, newVer))
		} else {
			emit("status", fmt.Sprintf("Version after update: %s", newVer))
		}
		emit("done", "success")
		LogActivity("system", fmt.Sprintf("Ollama updated on %s (%s): %s → %s", targetSrv.Name, host, currentVer, newVer))
		return false
	})
}

// buildSSHAuthMethods assembles SSH auth methods in priority order (stored key,
// agent, ~/.ssh/ files, DB keys, password). Shared by deploy and update flows.
func buildSSHAuthMethods(keyID, password string, useKey bool) []gossh.AuthMethod {
	var methods []gossh.AuthMethod

	if keyID != "" {
		if pem, err := GetSSHKeyPEMByID(keyID); err == nil {
			if signer, err := gossh.ParsePrivateKey(pem); err == nil {
				methods = append(methods, gossh.PublicKeys(signer))
			}
		}
	}

	if useKey || password == "" {
		if sock := os.Getenv("SSH_AUTH_SOCK"); sock != "" {
			if conn, err := net.Dial("unix", sock); err == nil { // #nosec G704
				methods = append(methods, gossh.PublicKeysCallback(sshagent.NewClient(conn).Signers))
			}
		}
		home, _ := os.UserHomeDir()
		for _, kf := range []string{
			filepath.Join(home, ".ssh", "id_ed25519"),
			filepath.Join(home, ".ssh", "id_ecdsa"),
			filepath.Join(home, ".ssh", "id_rsa"),
		} {
			if raw, err := os.ReadFile(kf); err == nil { // #nosec G304
				if signer, err := gossh.ParsePrivateKey(raw); err == nil {
					methods = append(methods, gossh.PublicKeys(signer))
				}
			}
		}
		if keyID == "" {
			if pems, err := GetSSHKeyPEMs(); err == nil {
				for _, pem := range pems {
					if signer, err := gossh.ParsePrivateKey(pem); err == nil {
						methods = append(methods, gossh.PublicKeys(signer))
					}
				}
			}
		}
	}

	if password != "" {
		methods = append(methods, gossh.Password(password))
		methods = append(methods, gossh.KeyboardInteractive(func(_, _ string, questions []string, _ []bool) ([]string, error) {
			ans := make([]string, len(questions))
			for i := range ans {
				ans[i] = password
			}
			return ans, nil
		}))
	}
	return methods
}

// shellEscapeSingle wraps s in single quotes, escaping any embedded single quotes.
func shellEscapeSingle(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

type sshClientWrapper struct {
	client *gossh.Client
	ctx    context.Context
}

func (w *sshClientWrapper) NewSession() (*gossh.Session, error) {
	return w.client.NewSession()
}

func (w *sshClientWrapper) Close() error {
	return w.client.Close()
}

// runSSHCmd runs a single command over SSH and returns trimmed combined output, supporting context cancellation.
func runSSHCmd(client *sshClientWrapper, cmd string) (string, error) {
	sess, err := client.NewSession()
	if err != nil {
		return "", err
	}
	defer sess.Close()

	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-client.ctx.Done():
			_ = sess.Signal(gossh.SIGINT)
			_ = sess.Close()
		case <-done:
		}
	}()

	out, err := sess.CombinedOutput(cmd)
	if client.ctx.Err() != nil {
		return "", client.ctx.Err()
	}
	return strings.TrimSpace(string(out)), err
}

// runSSHCmdStream runs a command over SSH, streaming each output line to emit, supporting context cancellation.
func runSSHCmdStream(client *sshClientWrapper, cmd string, emit func(string)) error {
	sess, err := client.NewSession()
	if err != nil {
		return err
	}
	defer sess.Close()

	stdoutPipe, _ := sess.StdoutPipe()
	stderrPipe, _ := sess.StderrPipe()

	if err := sess.Start(cmd); err != nil {
		return err
	}

	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-client.ctx.Done():
			_ = sess.Signal(gossh.SIGINT)
			_ = sess.Close()
		case <-done:
		}
	}()

	var wg sync.WaitGroup
	wg.Add(2)
	scan := func(r io.Reader) {
		defer wg.Done()
		sc := bufio.NewScanner(r)
		for sc.Scan() {
			emit(sc.Text())
		}
	}
	go scan(stdoutPipe)
	go scan(stderrPipe)
	wg.Wait()

	if client.ctx.Err() != nil {
		return client.ctx.Err()
	}
	return sess.Wait()
}

// sshCheckStr returns (detail string, passed bool) after running a command; if
// the command exits without error the first line of output is used as detail.
func sshCheckStr(client *sshClientWrapper, cmd, passDetail, failDetail string) (string, bool) {
	out, err := runSSHCmd(client, cmd)
	if err != nil {
		if failDetail != "" {
			return failDetail, false
		}
		return out, false
	}
	if passDetail != "" {
		return passDetail, true
	}
	return out, true
}

// GET /api/fleet/bootstrap
func bootstrapAgentHandler(c *gin.Context) {
	host := c.Request.Host
	if host == "" {
		host = "localhost:8811"
	}

	scheme := "http"
	if c.Request.TLS != nil {
		scheme = "https"
	}

	script := fmt.Sprintf(`#!/bin/bash
set -e

# Detect OS and architecture
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

if [ "$ARCH" = "x86_64" ]; then
    ARCH="amd64"
elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
    ARCH="arm64"
else
    echo "Unsupported architecture: $ARCH"
    exit 1
fi

if [ "$OS" != "linux" ] && [ "$OS" != "darwin" ]; then
    echo "Unsupported OS: $OS"
    exit 1
fi

echo "Installing neuro-agent for $OS/$ARCH..."
sudo mkdir -p /usr/local/bin

# Download binary
echo "Downloading agent binary..."
sudo curl -k -o /usr/local/bin/neuro-agent -fL "%s://%s/api/fleet/download-agent/$OS/$ARCH"
sudo chmod 755 /usr/local/bin/neuro-agent

# Start agent to generate config & credentials
echo "Starting neuro-agent temporarily to generate API keys..."
sudo /usr/local/bin/neuro-agent --port 11435 &
AGENT_PID=$!
sleep 2
sudo kill $AGENT_PID || true

# Read credentials
INFO_FILE="$HOME/.config/neuro-agent/info.json"
if [ "$OS" = "linux" ] && [ "$USER" = "root" ]; then
    INFO_FILE="/root/.config/neuro-agent/info.json"
fi

if [ ! -f "$INFO_FILE" ]; then
    INFO_FILE="/usr/local/etc/neuro-agent/info.json"
fi

# Fallback check if it was run as root
if [ ! -f "$INFO_FILE" ] && [ -f "/root/.config/neuro-agent/info.json" ]; then
    INFO_FILE="/root/.config/neuro-agent/info.json"
fi

if [ ! -f "$INFO_FILE" ]; then
    echo "Error: neuro-agent credentials could not be initialized."
    exit 1
fi

API_KEY=$(grep -o '"api_key":"[^"]*' "$INFO_FILE" | grep -o '[^"]*$')
FINGERPRINT=$(grep -o '"fingerprint":"[^"]*' "$INFO_FILE" | grep -o '[^"]*$')

# Install Service Daemon
if [ "$OS" = "linux" ]; then
    echo "Installing systemd service..."
    SERVICE_FILE="[Unit]
Description=NeuroAgent Service
After=network.target

[Service]
ExecStart=/usr/local/bin/neuro-agent --port 11435
Restart=always
User=root

[Install]
WantedBy=multi-user.target"
    echo "$SERVICE_FILE" | sudo tee /etc/systemd/system/neuro-agent.service > /dev/null
    sudo systemctl daemon-reload
    sudo systemctl enable neuro-agent
    sudo systemctl restart neuro-agent
    echo "✔ Service enabled and started via systemd"
elif [ "$OS" = "darwin" ]; then
    echo "Installing launchd plist..."
    PLIST_FILE="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key>
  <string>com.neurollama.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/neuro-agent</string>
    <string>--port</string>
    <string>11435</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>"
    echo "$PLIST_FILE" | sudo tee /Library/LaunchDaemons/com.neurollama.agent.plist > /dev/null
    sudo launchctl load -w /Library/LaunchDaemons/com.neurollama.agent.plist 2>/dev/null || true
    echo "✔ Service enabled and started via launchd"
fi

# Detect Local VRAM
VRAM="0"
if command -v nvidia-smi &> /dev/null; then
    VRAM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | awk '{sum+=$1} END {print sum/1024}')
fi

# Register back with central Neurollama server
IP_ADDR=$(hostname -I | awk '{print $1}' 2>/dev/null || ip route get 1 | awk '{print $NF;exit}' 2>/dev/null || echo "")
if [ -z "$IP_ADDR" ]; then
    IP_ADDR="localhost"
fi

echo "Registering agent back to controller..."
curl -k -X POST "%s://%s/api/fleet/register-agent" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"http://$IP_ADDR:11434\",\"agent_port\":11435,\"agent_key\":\"$API_KEY\",\"agent_fingerprint\":\"$FINGERPRINT\",\"vram_gb\":$VRAM}"

echo ""
echo "✔ Node pull installation complete and registered successfully!"
`, scheme, host, scheme, host)

	c.Data(http.StatusOK, "text/plain; charset=utf-8", []byte(script))
}

// GET /api/fleet/download-agent/:os/:arch
func downloadAgentBinaryHandler(c *gin.Context) {
	goos := c.Param("os")
	goarch := c.Param("arch")

	if goos != "linux" && goos != "darwin" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Unsupported OS"})
		return
	}
	if goarch != "amd64" && goarch != "arm64" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Unsupported arch"})
		return
	}

	binName := fmt.Sprintf("neuro-agent-%s-%s", goos, goarch)
	binPath := filepath.Join(os.TempDir(), binName)

	cmd := exec.Command("go", "build", "-o", binPath, "./neuro-agent/")
	cmd.Env = append(os.Environ(), "GOOS="+goos, "GOARCH="+goarch)

	if out, err := cmd.CombinedOutput(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to compile agent: %v (details: %s)", err, string(out))})
		return
	}
	defer os.Remove(binPath)

	c.Header("Content-Description", "File Transfer")
	c.Header("Content-Transfer-Encoding", "binary")
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%s", binName))
	c.Header("Content-Type", "application/octet-stream")
	c.File(binPath)
}

// POST /api/fleet/register-agent
func registerAgentHandler(c *gin.Context) {
	var req struct {
		Name             string  `json:"name"`
		URL              string  `json:"url"`
		AgentPort        int     `json:"agent_port"`
		AgentKey         string  `json:"agent_key"`
		AgentFingerprint string  `json:"agent_fingerprint"`
		VramGB           float64 `json:"vram_gb"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if req.URL == "" {
		clientIP := c.ClientIP()
		req.URL = fmt.Sprintf("http://%s:11434", clientIP)
	}
	if req.AgentPort == 0 {
		req.AgentPort = 11435
	}
	if req.Name == "" {
		u, err := url.Parse(req.URL)
		if err == nil && u.Hostname() != "" {
			req.Name = u.Hostname()
		} else {
			req.Name = "agent-node"
		}
	}

	newSrv, err := AddServer(
		req.Name, req.URL,
		"", "", "", "", "", "",
		req.VramGB,
		req.AgentPort, req.AgentKey, req.AgentFingerprint,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	pollOneNodeStatus(newSrv)

	LogActivity("node", fmt.Sprintf("Node registered via Pull Agent check-in: %s (%s)", req.Name, req.URL))
	c.JSON(http.StatusCreated, gin.H{
		"message": "Node registered successfully via pull bootstrap",
		"server":  newSrv,
	})
}
