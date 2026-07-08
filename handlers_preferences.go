package main

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// ── User Preferences Handlers ─────────────────────────────────────────────────

func getPreferencesHandler(c *gin.Context) {
	prefs, err := GetAllPreferences("admin")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, prefs)
}

type SetPreferenceRequest struct {
	Key   string `json:"key" binding:"required"`
	Value string `json:"value"`
}

func setPreferenceHandler(c *gin.Context) {
	var req SetPreferenceRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := SetPreference("admin", req.Key, req.Value); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func clearPreferencesHandler(c *gin.Context) {
	if err := ClearPreferences("admin"); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
