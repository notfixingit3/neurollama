package main

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
	goPDF "github.com/ledongthuc/pdf"
)

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
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
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
func chunkTextGo(text string, size, overlap int) []string {
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

		if end < n {
			maxSearch := 100
			if maxSearch > end-start {
				maxSearch = end - start
			}
			for searchIdx := 0; searchIdx < maxSearch; searchIdx++ {
				ch := text[end-searchIdx]
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

func uploadAndIndexHandler(c *gin.Context) {
	const (
		maxFileBytes   = 50 * 1024 * 1024
		maxPages       = 300
		chunkSize      = 800
		chunkOverlap   = 100
		embedBatchSize = 50
	)

	type ndjsonEvent = map[string]any
	emit := func(event ndjsonEvent) {
		data, _ := json.Marshal(event)
		data = append(data, '\n')
		_, _ = c.Writer.Write(data)
		c.Writer.Flush()
	}

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

	c.Header("Content-Type", "application/x-ndjson")
	c.Header("Transfer-Encoding", "chunked")
	c.Header("X-Accel-Buffering", "no")
	c.Header("Cache-Control", "no-cache")

	fileMB := float64(fh.Size) / (1024 * 1024)
	emit(ndjsonEvent{"type": "progress", "pct": 5, "message": fmt.Sprintf("Reading %s (%.1f MB)...", filename, fileMB)})

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
			_ = tmp.Close()
			emit(ndjsonEvent{"type": "error", "message": "Could not open upload"})
			return
		}
		_, copyErr := io.Copy(tmp, src)
		_ = src.Close()
		_ = tmp.Close()
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
			_ = f.Close()
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
		_ = f.Close()

		rawText = sb.String()
		skipNote := ""
		if skipped > 0 {
			skipNote = fmt.Sprintf(", %d page(s) skipped", skipped)
		}
		emit(ndjsonEvent{"type": "progress", "pct": 30, "message": fmt.Sprintf("Extracted %d chars from %d pages%s", len(rawText), numPages, skipNote)})

	} else {
		src, err := fh.Open()
		if err != nil {
			emit(ndjsonEvent{"type": "error", "message": "Could not open upload"})
			return
		}
		raw, err := io.ReadAll(src)
		_ = src.Close()
		if err != nil {
			emit(ndjsonEvent{"type": "error", "message": "Failed to read file"})
			return
		}
		rawText = string(raw)
		emit(ndjsonEvent{"type": "progress", "pct": 30, "message": fmt.Sprintf("Read %d chars", len(rawText))})
	}

	if strings.TrimSpace(rawText) == "" {
		emit(ndjsonEvent{"type": "error", "message": "No extractable text found. This may be an image-only or scanned PDF — try running it through OCR first."})
		return
	}

	emit(ndjsonEvent{"type": "progress", "pct": 35, "message": "Chunking into ~800-char blocks (100-char overlap)..."})
	chunks := chunkTextGo(rawText, chunkSize, chunkOverlap)
	if len(chunks) == 0 {
		emit(ndjsonEvent{"type": "error", "message": "Text chunking produced no output"})
		return
	}
	emit(ndjsonEvent{"type": "progress", "pct": 40, "message": fmt.Sprintf("%d chunk(s) created", len(chunks))})

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

		batch, err := ollamaClient.GetEmbeddings(c.Request.Context(), embeddingModel, chunks[start:end])
		if err != nil {
			emit(ndjsonEvent{"type": "error", "message": fmt.Sprintf("Embedding batch %d/%d failed: %v", b+1, totalBatches, err)})
			return
		}
		allEmbeddings = append(allEmbeddings, batch...)

		pct := 45 + int(float64(b+1)/float64(totalBatches)*47)
		emit(ndjsonEvent{"type": "progress", "pct": pct, "message": fmt.Sprintf("Embedded batch %d/%d (%d/%d chunks)", b+1, totalBatches, end, len(chunks))})
	}

	if len(allEmbeddings) != len(chunks) {
		emit(ndjsonEvent{"type": "error", "message": fmt.Sprintf("Embedding count mismatch: got %d, want %d", len(allEmbeddings), len(chunks))})
		return
	}

	emit(ndjsonEvent{"type": "progress", "pct": 93, "message": "Saving to database..."})

	ragChunks := make([]RAGChunk, len(chunks))
	for i, chk := range chunks {
		ragChunks[i] = RAGChunk{
			ChunkIndex: i,
			Content:    chk,
			Embedding:  allEmbeddings[i],
		}
	}

	collection := c.PostForm("collection")
	if collection == "" {
		collection = "Default"
	}
	docID, err := SaveRAGDocument(filename, embeddingModel, collection, ragChunks)
	if err != nil {
		emit(ndjsonEvent{"type": "error", "message": fmt.Sprintf("Database save failed: %v", err)})
		return
	}

	LogActivity("rag", fmt.Sprintf("Indexed: %s — %d chunks via %s (collection: %s)", filename, len(ragChunks), embeddingModel, collection))
	emit(ndjsonEvent{"type": "done", "document_id": docID, "chunks": len(ragChunks), "collection": collection})
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
		batch, err := client.GetEmbeddings(c.Request.Context(), req.EmbeddingModel, texts[start:end])
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

	var chunksToSave []RAGChunk
	for i, ch := range req.Chunks {
		chunksToSave = append(chunksToSave, RAGChunk{
			ChunkIndex: ch.ChunkIndex,
			Content:    ch.Content,
			Embedding:  embeddings[i],
		})
	}

	docID, err := SaveRAGDocument(req.Name, req.EmbeddingModel, "Default", chunksToSave)
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
		batch, err := client.GetEmbeddings(c.Request.Context(), req.EmbeddingModel, texts[start:end])
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

func updateRAGDocumentCollectionHandler(c *gin.Context) {
	idStr := c.Param("id")
	var id int64
	if _, err := fmt.Sscanf(idStr, "%d", &id); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid document ID"})
		return
	}
	var body struct {
		Collection string `json:"collection"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := UpdateRAGDocumentCollection(id, body.Collection); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Collection updated"})
}

func getRAGCollectionsHandler(c *gin.Context) {
	cols, err := GetRAGCollections()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if cols == nil {
		cols = []string{}
	}
	c.JSON(http.StatusOK, cols)
}

func queryRAGSimilarityHandler(c *gin.Context) {
	var req struct {
		Query          string `json:"query" binding:"required"`
		EmbeddingModel string `json:"embedding_model" binding:"required"`
		TopK           int    `json:"top_k"`
		Collection     string `json:"collection"`
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

	embeddings, err := client.GetEmbeddings(c.Request.Context(), req.EmbeddingModel, []string{req.Query})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("Failed to embed query: %v", err)})
		return
	}
	if len(embeddings) == 0 {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "No query embedding returned"})
		return
	}
	queryEmbed := embeddings[0]

	allChunks, err := GetRAGChunksForModel(req.EmbeddingModel, req.Collection)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	if len(allChunks) > 0 {
		if len(queryEmbed) != len(allChunks[0].Embedding) {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": fmt.Sprintf("Query vector dimension (%d) does not match document vector dimension (%d). Please verify that the selected embedding model matches the one used to index this collection.", len(queryEmbed), len(allChunks[0].Embedding)),
			})
			return
		}
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
