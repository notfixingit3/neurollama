package main

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

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
		req.AgentPort, req.AgentKey, req.AgentFingerprint,
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
	version, latency, err := client.CheckStatus(c.Request.Context())
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
	version, latency, err := client.CheckStatus(c.Request.Context())
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
		req.AgentPort, req.AgentKey, req.AgentFingerprint,
		req.AgentSSHUser, req.AgentSSHKeyID, req.AgentSSHPort,
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

	nodeRunningMu.Lock()
	delete(nodeRunningCache, id)
	delete(nodeActiveModelsCache, id)
	nodeRunningMu.Unlock()

	nodeAgentMu.Lock()
	delete(nodeAgentCache, id)
	nodeAgentMu.Unlock()

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
	version, latency, err := client.CheckStatus(c.Request.Context())
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
