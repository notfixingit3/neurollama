package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

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

func renameChatHandler(c *gin.Context) {
	idStr := c.Param("id")
	var id int64
	if _, err := fmt.Sscanf(idStr, "%d", &id); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid chat ID"})
		return
	}
	var req struct {
		Title string `json:"title" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Title cannot be empty"})
		return
	}
	if len([]rune(title)) > 120 {
		runes := []rune(title)
		title = string(runes[:120])
	}
	if err := UpdateChatTitle(id, title); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"title": title})
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

func searchChatsHandler(c *gin.Context) {
	q := strings.TrimSpace(c.Query("q"))
	if q == "" {
		c.JSON(http.StatusOK, []ChatSearchResult{})
		return
	}
	results, err := SearchChats(q, 25)
	if err != nil {
		log.Printf("FTS5 search error for query %q: %v", q, err)
		c.JSON(http.StatusOK, []ChatSearchResult{})
		return
	}
	if results == nil {
		results = []ChatSearchResult{}
	}
	c.JSON(http.StatusOK, results)
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

	summary, err := CompressChatSession(c.Request.Context(), id, chat.Model)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Chat compressed successfully", "summary": summary})
}

// Context Compression Functions
func CompressChatSession(ctx context.Context, chatID int64, modelName string) (string, error) {
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

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("%s/api/generate", client.BaseURL), bytes.NewBuffer(reqBody))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.HTTPClient.Do(req)
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
	defer func() { _ = tx.Rollback() }()

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

func trimChatHandler(c *gin.Context) {
	idStr := c.Param("id")
	var id int64
	if _, err := fmt.Sscanf(idStr, "%d", &id); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid chat ID"})
		return
	}

	var req struct {
		KeepCount int `json:"keep_count"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}
	if req.KeepCount < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "keep_count must be >= 0"})
		return
	}

	if err := TrimChatMessages(id, req.KeepCount); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Chat trimmed", "keep_count": req.KeepCount})
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
