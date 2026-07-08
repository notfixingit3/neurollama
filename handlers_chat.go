package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
)

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
	RagCollection     string        `json:"rag_collection"`
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

			summary, err := CompressChatSession(c.Request.Context(), *req.ChatID, req.Model)
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
			embeddings, err := client.GetEmbeddings(c.Request.Context(), req.RagEmbeddingModel, []string{chatReq.Messages[lastUserMsgIdx].Content})
			if err == nil && len(embeddings) > 0 {
				queryEmbed := embeddings[0]
				allChunks, err := GetRAGChunksForModel(req.RagEmbeddingModel, req.RagCollection)
				if err == nil && len(allChunks) > 0 {
					if len(queryEmbed) != len(allChunks[0].Embedding) {
						log.Printf("RAG warning: Query vector dimension (%d) does not match document vector dimension (%d). Skipping RAG context injection.", len(queryEmbed), len(allChunks[0].Embedding))
					} else {
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
