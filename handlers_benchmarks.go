package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/csv"
	goparser "go/parser"
	"go/token"
	"encoding/json"
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
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

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

// exportBenchmarksCSVHandler streams benchmark data as a CSV download.
// Accepts ?type=all|standard|vision|embedding|longctx|reasoning to filter.
func exportBenchmarksCSVHandler(c *gin.Context) {
	filter := c.DefaultQuery("type", "all")

	all, err := GetBenchmarks()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	var rows []Benchmark
	for _, b := range all {
		if filter == "" || filter == "all" || b.BenchmarkType == filter {
			rows = append(rows, b)
		}
	}
	if len(rows) == 0 {
		c.JSON(http.StatusOK, gin.H{"message": "No benchmark data to export"})
		return
	}

	filename := fmt.Sprintf("neurollama-benchmarks-%s.csv", time.Now().Format("2006-01-02"))
	c.Header("Content-Type", "text/csv; charset=utf-8")
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))

	w := csv.NewWriter(c.Writer)
	_ = w.Write([]string{"ID", "Model", "Server", "Type", "TTFT_ms", "TPS_or_metric", "Latency_ms", "Score", "Notes", "Date"})

	for _, b := range rows {
		var ex struct {
			ChunksPerSec *float64 `json:"chunks_per_sec"`
			AccuracyPct  *float64 `json:"accuracy_pct"`
		}
		if b.ExtraJSON != "" {
			_ = json.Unmarshal([]byte(b.ExtraJSON), &ex)
		}
		metric := b.Tps
		switch b.BenchmarkType {
		case "embedding":
			if ex.ChunksPerSec != nil { metric = *ex.ChunksPerSec }
		case "reasoning":
			if ex.AccuracyPct != nil { metric = *ex.AccuracyPct }
		}
		notes := b.Notes
		if notes == "auto" { notes = "" }

		_ = w.Write([]string{
			strconv.FormatInt(b.ID, 10),
			b.ModelName, b.ServerName, b.BenchmarkType,
			strconv.FormatFloat(b.TtftMs, 'f', 2, 64),
			strconv.FormatFloat(metric, 'f', 2, 64),
			strconv.FormatFloat(b.AvgLatencyMs, 'f', 2, 64),
			b.ReasoningScore, notes, b.CreatedAt,
		})
	}
	w.Flush()
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
		{191, 97, 106, 255},  // Nord aurora red
		{163, 190, 140, 255}, // Nord aurora green
		{136, 192, 208, 255}, // Nord frost blue
		{235, 203, 139, 255}, // Nord aurora yellow
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

// codeBenchTasks defines the 12-language code benchmark suite.
var codeBenchTasks = []struct {
	Lang   string
	Label  string
	Task   string
	Prompt string
}{
	{
		Lang: "python", Label: "Python", Task: "fizzbuzz",
		Prompt: `Write a Python function named fizzbuzz(n) that takes a positive integer n and returns a list of strings for numbers 1 through n: "Fizz" for multiples of 3, "Buzz" for multiples of 5, "FizzBuzz" for both, otherwise the number as a string. Include only the function, no explanation.`,
	},
	{
		Lang: "go", Label: "Go", Task: "reverseWords",
		Prompt: `Write a Go function named reverseWords(s string) string that reverses the order of whitespace-separated words in the input string. Include only the function and any necessary imports, no package declaration, no explanation.`,
	},
	{
		Lang: "javascript", Label: "JavaScript", Task: "debounce",
		Prompt: `Write a JavaScript function named debounce(fn, ms) that returns a debounced version of fn that delays invoking fn until ms milliseconds have elapsed since the last invocation. Include only the function, no explanation.`,
	},
	{
		Lang: "typescript", Label: "TypeScript", Task: "typed debounce",
		Prompt: `Write a TypeScript generic function debounce<T extends (...args: any[]) => any>(fn: T, ms: number): (...args: Parameters<T>) => void that debounces fn. Include full type annotations. Include only the function, no explanation.`,
	},
	{
		Lang: "node", Label: "Node.js", Task: "file line counter",
		Prompt: `Write a Node.js script that reads a filename from process.argv[2], counts non-empty lines, and prints the count to stdout. Use only built-in Node.js modules (fs). Include only the script, no explanation.`,
	},
	{
		Lang: "bash", Label: "Bash", Task: "delete old logs",
		Prompt: `Write a bash script starting with #!/bin/bash that accepts a directory path as $1 and deletes all .log files in that directory older than 7 days (use find), printing each deleted filepath to stdout. Include only the script, no explanation.`,
	},
	{
		Lang: "sh", Label: "sh (POSIX)", Task: "POSIX delete old logs",
		Prompt: `Write a POSIX sh script starting with #!/bin/sh (no bash extensions) that accepts a directory path as $1 and deletes all .log files older than 7 days using find, printing each deleted filepath to stdout. Include only the script, no explanation.`,
	},
	{
		Lang: "rust", Label: "Rust", Task: "fibonacci vec",
		Prompt: `Write a Rust function named fibonacci(n: usize) -> Vec<u64> that returns a Vec of the first n Fibonacci numbers starting with [0, 1, 1, 2, ...]. Include only the function, no main, no explanation.`,
	},
	{
		Lang: "php", Label: "PHP", Task: "filter adults from JSON",
		Prompt: `Write a PHP function named filterAdults(string $json): array that decodes a JSON string of {"users":[{"name":"...","age":N},...]} and returns only the user arrays where age >= 18. Include only the function, no explanation.`,
	},
	{
		Lang: "ruby", Label: "Ruby", Task: "find duplicates",
		Prompt: `Write a Ruby method named find_duplicates(arr) that accepts an array and returns a sorted array of elements that appear more than once (each duplicate listed once). Include only the method, no explanation.`,
	},
	{
		Lang: "c", Label: "C", Task: "array stack",
		Prompt: `Write C code (C99) for a fixed-size stack using an array. Use typedef struct { int data[64]; int top; } Stack; and three functions: void push(Stack* s, int v), int pop(Stack* s, int* out), int is_empty(Stack* s). Use typedef struct so Stack can be used without the struct keyword. Do not use printf or any I/O — use return values only for errors. Include only the typedef and functions, no includes, no main, no explanation.`,
	},
	{
		Lang: "sql", Label: "SQL", Task: "top customers by value",
		Prompt: `Write a SQL query against table orders(order_id INTEGER, customer_id INTEGER, customer_name TEXT, amount DECIMAL) that returns the top 5 customers by total order value, with columns customer_name and total_amount, ordered descending. Include only the SQL, no explanation.`,
	},
}

// stripThinkBlocks removes <think>…</think> (and <thinking>…</thinking>) blocks
// emitted by reasoning/thinking models (DeepSeek-R1, Gemma4 thinking variants, etc.)
// before we try to extract structured output from a response.
func stripThinkBlocks(s string) string {
	for _, pair := range [][2]string{
		{"<think>", "</think>"},
		{"<thinking>", "</thinking>"},
	} {
		open, close := pair[0], pair[1]
		for {
			start := strings.Index(s, open)
			if start == -1 {
				break
			}
			end := strings.Index(s[start:], close)
			if end == -1 {
				s = s[:start] // unclosed tag — drop from here to end
				break
			}
			s = s[:start] + s[start+end+len(close):]
		}
	}
	return strings.TrimSpace(s)
}

// ansiRE matches ANSI terminal escape sequences (colours, cursor movement, etc.)
var ansiRE = regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]`)

// stripANSI removes ANSI escape codes so raw checker output is readable in our console.
func stripANSI(s string) string { return ansiRE.ReplaceAllString(s, "") }

// warmupModel sends a single-token request to ensure the model is loaded into
// VRAM and Metal/CUDA kernels are compiled before the real benchmark begins.
// The first inference after a model load is 5-10x slower (cold-start); this
// absorbs that cost so it doesn't skew TTFT numbers. Errors are ignored — if
// the warmup fails the benchmark will surface the real error on its own calls.
func warmupModel(ctx context.Context, client *OllamaClient, model string, numCtx int, logFunc func(string)) {
	logFunc(fmt.Sprintf("Warming up %s...", model))
	opts := map[string]interface{}{
		"temperature": 0.0,
		"num_predict": 1, // one token is enough to load & prime kernels
	}
	if numCtx > 0 {
		opts["num_ctx"] = numCtx
	}
	req := GenerateRequest{
		Model:   model,
		Prompt:  "Hi",
		Stream:  true,
		Options: opts,
	}
	stream, err := client.StreamGenerate(ctx, req)
	if err != nil {
		return // best-effort; benchmark will handle real errors itself
	}
	defer func() { _ = stream.Close() }()
	scanner := newStreamScanner(stream)
	for scanner.Scan() {
	} // drain fully so the connection is clean
}

// nodeBuiltins is the set of bare Node.js core module names that Deno requires
// to be prefixed with "node:" (e.g. "timers" → "node:timers").
var nodeBuiltins = map[string]bool{
	"assert": true, "async_hooks": true, "buffer": true, "child_process": true,
	"cluster": true, "console": true, "crypto": true, "dgram": true, "dns": true,
	"domain": true, "events": true, "fs": true, "http": true, "http2": true,
	"https": true, "inspector": true, "module": true, "net": true, "os": true,
	"path": true, "perf_hooks": true, "process": true, "punycode": true,
	"querystring": true, "readline": true, "repl": true, "stream": true,
	"string_decoder": true, "timers": true, "tls": true, "tty": true, "url": true,
	"util": true, "v8": true, "vm": true, "worker_threads": true, "zlib": true,
}

// tsImportRE captures the leading quote character and the module specifier in
// TypeScript/JS import-from and require() statements.
var tsImportRE = regexp.MustCompile(`(from\s+["']|require\(["'])([a-z][a-z0-9_./-]*)`)

// normalizeNodeImports rewrites bare Node.js built-in imports to their "node:"
// prefixed form so Deno's type-checker accepts them without error.
func normalizeNodeImports(code string) string {
	return tsImportRE.ReplaceAllStringFunc(code, func(m string) string {
		sub := tsImportRE.FindStringSubmatch(m)
		if len(sub) < 3 {
			return m
		}
		lead, mod := sub[1], sub[2]
		// Check top-level name only (e.g. "fs" from "fs/promises")
		base := strings.SplitN(mod, "/", 2)[0]
		if nodeBuiltins[base] {
			return lead + "node:" + mod
		}
		return m
	})
}

// judgeCodePrompt builds a structured LLM-as-judge prompt for a code evaluation.
func judgeCodePrompt(lang, task, code string) string {
	return fmt.Sprintf(`You are a strict code quality evaluator. Rate the following %s code that was written for this task: "%s"

CODE:
%s

Score each criterion 0 to 10 (10 = perfect):
- correctness: Does the code correctly solve the stated task? Are edge cases handled?
- completeness: Is the code runnable/usable as-is? No placeholders, valid syntax?
- style: Is the code idiomatic and well-structured for %s?

Respond with ONLY a JSON object. No markdown, no explanation, no extra text:
{"correctness":N,"completeness":N,"style":N,"brief_critique":"one short sentence"}`,
		lang, task, code, lang)
}

// hallucinationFillerUnit is a ~150-word paragraph about distributed systems,
// repeated to fill a target context window for needle-in-a-haystack tests.
const hallucinationFillerUnit = `In distributed computing, fault tolerance describes a system's ability to continue correct operation despite component failures. Engineers design such systems using redundancy, replication, and consensus protocols. The Raft algorithm, for example, elects a leader among a cluster of servers, replicating log entries to a quorum of followers before acknowledging writes to the client. When a leader fails, the remaining nodes elect a new one without losing committed data. Byzantine fault tolerance extends these ideas to handle nodes that send arbitrarily incorrect messages rather than simply crashing. Systems like Google Spanner use TrueTime, a globally synchronised clock API, to provide external consistency across datacenters. Horizontal scaling distributes load across commodity hardware, while consistent hashing minimises rebalancing when nodes join or leave a cluster. Modern cloud architectures combine these techniques with chaos engineering — intentionally injecting failures — to verify that redundancy mechanisms function correctly under real conditions. `

const hallucinationNeedle   = "ORION-DELTA-9"
const hallucinationSecret   = "The emergency override code for sector 7 is: ORION-DELTA-9."
const hallucinationQuestion = "What is the emergency override code for sector 7? Reply with only the code itself, nothing else."

// contextSizesK returns all context sizes in tokens (thousands) up to maxK, doubling from 8k.
func contextSizesK(maxK int) []int {
	sizes := []int{8, 16, 32, 64, 128, 256, 512, 1024, 2048, 5120, 10240}
	var result []int
	for _, s := range sizes {
		if s <= maxK {
			result = append(result, s)
		}
	}
	if len(result) == 0 {
		result = []int{8}
	}
	return result
}

// buildHallucinationPrompt creates a prompt of approximately targetK*1000 tokens
// with the needle inserted at positionPct% of the filler length.
func buildHallucinationPrompt(targetK int, positionPct int) string {
	targetChars := targetK * 1000 * 4
	unitLen := len(hallucinationFillerUnit)
	totalUnits := targetChars / unitLen
	if totalUnits < 2 {
		totalUnits = 2
	}

	insertAt := (totalUnits * positionPct) / 100

	var sb strings.Builder
	sb.WriteString("Read the following document carefully, then answer the question at the end.\n\n")
	for i := 0; i < totalUnits; i++ {
		if i == insertAt {
			sb.WriteString("[CLASSIFIED RECORD] ")
			sb.WriteString(hallucinationSecret)
			sb.WriteString(" [END RECORD]\n\n")
		}
		sb.WriteString(hallucinationFillerUnit)
		sb.WriteString("\n\n")
	}
	sb.WriteString("\n\nQuestion: ")
	sb.WriteString(hallucinationQuestion)
	return sb.String()
}

// --- Benchmark runners ---

// runBenchmarkForPrompt returns (ttft_ms, tps, latency_ms, responseHead, error).
// responseHead is the first 300 chars of the response, used for greeting/refusal detection.
func runBenchmarkForPrompt(ctx context.Context, client *OllamaClient, model string, prompt string, logFunc func(string)) (float64, float64, float64, string, error) {
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
		return 0, 0, 0, "", err
	}
	defer func() { _ = stream.Close() }()

	var firstTokenTime time.Duration
	var firstTokenReceived bool
	var tokenCount int
	var respHead strings.Builder
	var lastHeartbeat time.Time

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
				if respHead.Len() < 300 {
					respHead.WriteString(chunk.Response)
				}
			}
		}
		if logFunc != nil && time.Since(lastHeartbeat) > 5*time.Second {
			elapsed := time.Since(start).Round(time.Second)
			logFunc(fmt.Sprintf("  Generating… %d tokens · %s elapsed", tokenCount, elapsed))
			lastHeartbeat = time.Now()
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

	return ttftMs, tps, avgLatency, respHead.String(), nil
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
	embeddings, embedErr := client.GetEmbeddings(ctx, model, chunks)
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

// syntaxCheckerTools describes each language's syntax checker binary and how to get it.
var syntaxCheckerTools = []struct {
	Lang        string
	Binary      string // exact binary name users should search for / install
	InstallHint string // human-readable install instructions
	SkipMsg     string // console message when binary is missing
}{
	{"python",     "python3",  "brew install python  |  python.org",                                        "install python3 to enable"},
	{"go",         "",         "built-in — no install needed",                                              ""},
	{"javascript", "node",     "brew install node  |  nodejs.org",                                          "install node to enable"},
	{"typescript", "deno",     "brew install deno  |  deno.com",                                            "install deno to enable"},
	{"node",       "node",     "brew install node  |  nodejs.org",                                          "install node to enable"},
	{"bash",       "bash",     "pre-installed on macOS/Linux",                                              "install bash to enable"},
	{"sh",         "sh",       "pre-installed on macOS/Linux",                                              "install sh to enable"},
	{"php",        "php",      "brew install php  |  php.net",                                              "install php to enable"},
	{"ruby",       "ruby",     "brew install ruby  |  ruby-lang.org",                                       "install ruby to enable"},
	{"rust",       "rustc",    "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh  |  rustup.rs", "install rustc (rustup) to enable"},
	{"c",          "gcc",      "brew install gcc  |  xcode-select --install  |  apt install build-essential", "install gcc or clang to enable"},
	{"sql",        "sqlfluff", "pip install sqlfluff  |  brew install sqlfluff  |  sqlfluff.com",           "install sqlfluff to enable"},
}

// checkerAvailable reports whether the syntax checker for a given language is present.
func checkerAvailable(lang string) bool {
	if lang == "go" {
		return true
	}
	for _, t := range syntaxCheckerTools {
		if t.Lang == lang {
			if t.Binary == "" {
				return false
			}
			_, err := exec.LookPath(t.Binary)
			return err == nil
		}
	}
	return false
}

// checkerSkipMsg returns a human-readable "skipped — <hint>" message.
func checkerSkipMsg(lang string) string {
	for _, t := range syntaxCheckerTools {
		if t.Lang == lang && t.SkipMsg != "" {
			return "skipped — " + t.SkipMsg
		}
	}
	return "skipped"
}

// codeSyntaxCheckersHandler returns availability of each syntax checker tool.
func codeSyntaxCheckersHandler(c *gin.Context) {
	type checkerInfo struct {
		Lang        string `json:"lang"`
		Available   bool   `json:"available"`
		Binary      string `json:"binary,omitempty"`
		InstallHint string `json:"install_hint,omitempty"`
	}
	var result []checkerInfo
	for _, t := range syntaxCheckerTools {
		avail := false
		switch t.Lang {
		case "go":
			avail = true
		default:
			if t.Binary != "" {
				_, err := exec.LookPath(t.Binary)
				avail = err == nil
			}
		}
		result = append(result, checkerInfo{
			Lang:        t.Lang,
			Available:   avail,
			Binary:      t.Binary,
			InstallHint: t.InstallHint,
		})
	}
	c.JSON(http.StatusOK, result)
}

// isThinkingModel returns true when the model name strongly suggests it uses
// chain-of-thought / reasoning mode by default (Qwen3, QwQ, DeepSeek-R1, etc.).
func isThinkingModel(name string) bool {
	lower := strings.ToLower(name)
	for _, pat := range []string{"qwen3", "qwq", "deepseek-r1", "r1-", "-r1:", "marco-o1", "skywork-o1", "llama-nemotron"} {
		if strings.Contains(lower, pat) {
			return true
		}
	}
	return false
}

// boolPtr returns a pointer to a bool — used for optional JSON fields.
func boolPtr(b bool) *bool { return &b }

// thinkParam returns think=false for thinking models.
func thinkParam(model string) *bool {
	if isThinkingModel(model) {
		return boolPtr(false)
	}
	return nil
}

// noThinkPrompt appends /no_think to a prompt for thinking models.
func noThinkPrompt(model, prompt string) string {
	if isThinkingModel(model) {
		return prompt + " /no_think"
	}
	return prompt
}

// isRefusalResponse returns true when the generated text looks like a safety
// or capability refusal. These should be flagged REFUSED and skipped.
func isRefusalResponse(text string) bool {
	if len(text) == 0 {
		return false
	}
	head := strings.ToLower(text)
	if len(head) > 120 {
		head = head[:120]
	}
	for _, pat := range []string{
		"i cannot fulfill",
		"i can't fulfill",
		"i'm unable to",
		"i am unable to",
		"i cannot generate",
		"i can't generate",
		"i'm not able to",
		"i am not able to",
		"i cannot provide",
		"i can't provide",
		"violates safety",
		"against my guidelines",
		"i cannot assist",
		"i can't assist",
		"as an ai",
		"as a language model",
		"i don't feel comfortable",
		"i'm sorry, but i",
		"i apologize, but i",
	} {
		if strings.Contains(head, pat) {
			return true
		}
	}
	return false
}

// isGreetingResponse returns true when the model outputs a chat welcome message
// instead of following the task prompt.
func isGreetingResponse(text string) bool {
	if len(text) == 0 {
		return false
	}
	head := strings.ToLower(text)
	if len(head) > 200 {
		head = head[:200]
	}
	for _, pat := range []string{
		"i'm ready to help",
		"i am ready to help",
		"what would you like to work on",
		"what would you like me to",
		"how can i help you",
		"how can i assist you",
		"how may i help",
		"how may i assist",
		"i'd be happy to help",
		"i am here to help",
		"i'm here to help",
		"what can i help you with",
		"what can i assist you with",
		"i'm your assistant",
		"i am your assistant",
		"welcome! i",
		"hello! i",
		"hi! i",
		"greetings! i",
	} {
		if strings.Contains(head, pat) {
			return true
		}
	}
	return false
}

const judgeSystemPrompt = "Output only a JSON object. No explanations, no markdown, no preamble."

// runCodeBenchmarkRun tests a list of languages, returning per-language results.
func runCodeBenchmarkRun(ctx context.Context, client *OllamaClient, model, judgeModel string, langs []string, numCtx int, logFunc func(string), debug bool) ([]map[string]interface{}, error) {
	if judgeModel == "" || judgeModel == "same" {
		judgeModel = model
	}

	warmupModel(ctx, client, model, numCtx, logFunc)
	if judgeModel != model {
		warmupModel(ctx, client, judgeModel, numCtx, logFunc)
	}

	taskMap := make(map[string]struct{ Label, Task, Prompt string })
	for _, t := range codeBenchTasks {
		taskMap[t.Lang] = struct{ Label, Task, Prompt string }{t.Label, t.Task, t.Prompt}
	}

	var results []map[string]interface{}

	for _, lang := range langs {
		t, ok := taskMap[lang]
		if !ok {
			logFunc(fmt.Sprintf("[%s] unknown language, skipping", lang))
			continue
		}

		logFunc(fmt.Sprintf("[%s] Generating %s code...", t.Label, t.Task))

		// --- Pass 1: Generate code ---
		genReq := GenerateRequest{
			Model:  model,
			Prompt: noThinkPrompt(model, t.Prompt),
			Think:  thinkParam(model),
			Stream: true,
			Options: func() map[string]interface{} {
				o := map[string]interface{}{
					"temperature": 0.0,
					"num_predict": 1500,
				}
				if numCtx > 0 {
					o["num_ctx"] = numCtx
				}
				return o
			}(),
		}

		start := time.Now()
		stream, err := client.StreamGenerate(ctx, genReq)
		if err != nil {
			logFunc(fmt.Sprintf("[%s] Generation failed: %v", t.Label, err))
			results = append(results, map[string]interface{}{
				"lang": lang, "label": t.Label, "task": t.Task,
				"error": err.Error(), "syntax_ok": false,
				"judge": map[string]interface{}{"correctness": 0, "completeness": 0, "style": 0, "brief_critique": "generation failed"},
				"quality_score": 0.0, "tps": 0.0, "ttft_ms": 0.0,
			})
			continue
		}

		var firstTok time.Duration
		var gotFirst bool
		var toks int
		var codeBuilder strings.Builder

		scanner := newStreamScanner(stream)
		for scanner.Scan() {
			line := scanner.Bytes()
			if len(line) == 0 {
				continue
			}
			var chunk struct {
				Response string `json:"response"`
				Thinking string `json:"thinking"`
				Done     bool   `json:"done"`
			}
			if json.Unmarshal(line, &chunk) == nil {
				if chunk.Thinking != "" {
					toks++
				}
				if !gotFirst && (chunk.Response != "" || chunk.Thinking != "") {
					firstTok = time.Since(start)
					gotFirst = true
					logFunc(fmt.Sprintf("[%s] ⚡ First token: %.0fms", t.Label, float64(firstTok.Milliseconds())))
				}
				if chunk.Response != "" {
					toks++
					codeBuilder.WriteString(chunk.Response)
				}
			}
		}
		_ = stream.Close()

		genDur := time.Since(start)
		generatedCode := strings.TrimSpace(codeBuilder.String())

		if toks == 0 {
			logFunc(fmt.Sprintf("[%s] ⚠ Empty response — model may have output only in thinking field", t.Label))
		}

		generatedCode = stripThinkBlocks(generatedCode)

		if idx := strings.Index(generatedCode, "```"); idx != -1 {
			inner := generatedCode[idx+3:]
			if nl := strings.Index(inner, "\n"); nl != -1 {
				inner = inner[nl+1:]
			}
			if end := strings.Index(inner, "```"); end != -1 {
				inner = inner[:end]
			}
			generatedCode = strings.TrimSpace(inner)
		}

		genSec := genDur.Seconds() - firstTok.Seconds()
		if genSec <= 0 {
			genSec = 0.001
		}
		tps := math.Round(float64(toks)/genSec*10) / 10
		ttft := float64(firstTok.Milliseconds())

		logFunc(fmt.Sprintf("[%s] Generated (%d tokens, %.1f TPS). Running syntax check...", t.Label, toks, tps))

		// --- Greeting check ---
		if isGreetingResponse(generatedCode) {
			logFunc(fmt.Sprintf("[%s] ⚠ CHAT_MODEL — model ignored the prompt and output a chat greeting", t.Label))
			results = append(results, map[string]interface{}{
				"lang": lang, "label": t.Label, "task": t.Task,
				"error": "chat model", "syntax_ok": false,
				"judge": map[string]interface{}{"correctness": 0, "completeness": 0, "style": 0, "brief_critique": "model output a chat greeting instead of code"},
				"quality_score": 0.0, "tps": tps, "ttft_ms": ttft,
			})
			continue
		}

		// --- Refusal check ---
		if isRefusalResponse(generatedCode) {
			logFunc(fmt.Sprintf("[%s] ⚠ REFUSED — model declined to generate code (safety/policy refusal)", t.Label))
			results = append(results, map[string]interface{}{
				"lang": lang, "label": t.Label, "task": t.Task,
				"error": "model refused", "syntax_ok": false,
				"judge": map[string]interface{}{"correctness": 0, "completeness": 0, "style": 0, "brief_critique": "model refused to generate code"},
				"quality_score": 0.0, "tps": tps, "ttft_ms": ttft,
			})
			continue
		}

		// --- Pass 2: Syntax check ---
		syntaxOK, syntaxMsg := checkCodeSyntax(lang, generatedCode)
		if syntaxMsg == "skipped" {
			logFunc(fmt.Sprintf("[%s] Syntax check: %s", t.Label, checkerSkipMsg(lang)))
		} else if syntaxOK {
			logFunc(fmt.Sprintf("[%s] Syntax check: PASS", t.Label))
		} else {
			logFunc(fmt.Sprintf("[%s] Syntax check: FAIL — %s", t.Label, syntaxMsg))
		}

		// --- Pass 3: LLM judge ---
		judgeTarget := judgeModel
		if judgeTarget == "" || judgeTarget == "same" {
			judgeTarget = model
		}
		logFunc(fmt.Sprintf("[%s] Running LLM judge (%s)...", t.Label, judgeTarget))

		judgeReq := GenerateRequest{
			Model:  judgeTarget,
			Prompt: noThinkPrompt(judgeTarget, judgeCodePrompt(t.Label, t.Task, generatedCode)),
			System: judgeSystemPrompt,
			Think:  thinkParam(judgeTarget),
			Stream: true,
			Options: func() map[string]interface{} {
				o := map[string]interface{}{
					"temperature": 0.0,
					"num_predict": 2048,
				}
				if numCtx > 0 {
					o["num_ctx"] = numCtx
				}
				return o
			}(),
		}

		jStream, jErr := client.StreamGenerate(ctx, judgeReq)
		judgeResult := map[string]interface{}{
			"correctness":    0, "completeness": 0, "style": 0,
			"brief_critique": "judge unavailable",
		}
		qualityScore := 0.0

		if jErr == nil {
			var jRespBuilder, jThinkBuilder strings.Builder
			jScanner := newStreamScanner(jStream)
			firstChunk := true
			for jScanner.Scan() {
				line := jScanner.Bytes()
				if len(line) == 0 {
					continue
				}
				if debug && firstChunk {
					logFunc(fmt.Sprintf("[%s] [DBG] Judge chunk[0]: %.300s", t.Label, string(line)))
					firstChunk = false
				}
				var chunk struct {
					Response string `json:"response"`
					Thinking string `json:"thinking"`
				}
				if json.Unmarshal(line, &chunk) == nil {
					jRespBuilder.WriteString(chunk.Response)
					jThinkBuilder.WriteString(chunk.Thinking)
				}
			}
			_ = jStream.Close()

			respStr  := strings.TrimSpace(jRespBuilder.String())
			thinkStr := strings.TrimSpace(jThinkBuilder.String())
			if debug {
				logFunc(fmt.Sprintf("[%s] [DBG] Judge: resp=%dB think=%dB | %.120s", t.Label, len(respStr), len(thinkStr), respStr))
			}

			var jr struct {
				Correctness   float64 `json:"correctness"`
				Completeness  float64 `json:"completeness"`
				Style         float64 `json:"style"`
				BriefCritique string  `json:"brief_critique"`
			}
			parsed := false
			for _, candidate := range []string{respStr, thinkStr, thinkStr + "\n" + respStr} {
				stripped := stripThinkBlocks(candidate)
				end := strings.LastIndex(stripped, "}")
				for end > 0 && !parsed {
					start := strings.LastIndex(stripped[:end+1], "{")
					if start < 0 {
						break
					}
					if json.Unmarshal([]byte(stripped[start:end+1]), &jr) == nil {
						parsed = true
						break
					}
					end = strings.LastIndex(stripped[:end], "}")
				}
				if parsed {
					break
				}
			}

			if parsed {
				judgeResult = map[string]interface{}{
					"correctness":    math.Round(jr.Correctness*10) / 10,
					"completeness":   math.Round(jr.Completeness*10) / 10,
					"style":          math.Round(jr.Style*10) / 10,
					"brief_critique": jr.BriefCritique,
				}
				qualityScore = math.Round((jr.Correctness*0.5+jr.Completeness*0.3+jr.Style*0.2)*10) / 10
			} else {
				snippet := respStr + thinkStr
				if len(snippet) > 200 {
					snippet = snippet[:200]
				}
				logFunc(fmt.Sprintf("[%s] ✗ Judge parse failed — raw: %.200s", t.Label, snippet))
				judgeResult["brief_critique"] = "parse failed"
			}
		}

		if !syntaxOK && syntaxMsg != "skipped" && qualityScore > 4 {
			qualityScore = 4.0
		}

		logFunc(fmt.Sprintf("[%s] Quality: %.1f/10 | Syntax: %v | TPS: %.1f", t.Label, qualityScore, syntaxOK, tps))

		snippet := generatedCode
		if len(snippet) > 600 {
			snippet = snippet[:600] + "…"
		}

		results = append(results, map[string]interface{}{
			"lang":          lang,
			"label":         t.Label,
			"task":          t.Task,
			"tps":           tps,
			"ttft_ms":       ttft,
			"syntax_ok":     syntaxOK,
			"syntax_msg":    syntaxMsg,
			"judge":         judgeResult,
			"quality_score": qualityScore,
			"code_snippet":  snippet,
		})
	}

	return results, nil
}

// runCodeBenchmarkSSEHandler streams a code benchmark run.
func runCodeBenchmarkSSEHandler(c *gin.Context) {
	model := c.Query("model")
	if model == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "model required"})
		return
	}
	judgeModel := c.DefaultQuery("judge_model", "same")
	langsParam := c.DefaultQuery("langs", "python,go,javascript,typescript,node,bash,sh,rust,php,ruby,c,sql")
	langs := strings.Split(langsParam, ",")
	for i, l := range langs {
		langs[i] = strings.TrimSpace(l)
	}
	numCtx := 0
	if v, err := strconv.Atoi(c.Query("num_ctx")); err == nil && v > 0 {
		numCtx = v
	}

	activeSrv, err := GetActiveServer()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "No active Ollama server"})
		return
	}

	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("Transfer-Encoding", "chunked")

	client := NewOllamaClient(activeSrv)
	ctx := c.Request.Context()
	ollamaVer, _, _ := client.CheckStatus(ctx)
	debug := c.Query("debug") == "true"

	LogActivity("benchmark", fmt.Sprintf("Code benchmark started: %s (%d languages)", model, len(langs)))

	c.Stream(func(w io.Writer) bool {
		defer func() {
			if r := recover(); r != nil {
				c.SSEvent("error", fmt.Sprintf("panic: %v", r))
				c.Writer.Flush()
			}
			go func() {
				_ = client.UnloadModel(context.Background(), model)
				if judgeModel != "same" && judgeModel != "" && judgeModel != model {
					_ = client.UnloadModel(context.Background(), judgeModel)
				}
			}()
		}()

		emit := func(msg string) {
			c.SSEvent("status", msg)
			c.Writer.Flush()
		}

		if debug {
			emit("[DBG] Debug mode enabled")
		}
		ctxLabel := "model default"
		if numCtx > 0 {
			ctxLabel = fmt.Sprintf("%dK", numCtx/1024)
		}
		emit(fmt.Sprintf("Starting code benchmark: %s | %d languages | judge: %s | ctx: %s", model, len(langs), judgeModel, ctxLabel))

		results, runErr := runCodeBenchmarkRun(ctx, client, model, judgeModel, langs, numCtx, emit, debug)
		if runErr != nil {
			c.SSEvent("error", runErr.Error())
			c.Writer.Flush()
			return false
		}
		if len(results) == 0 {
			c.SSEvent("error", "No language results produced")
			c.Writer.Flush()
			return false
		}

		var sumQ, sumTPS float64
		passSyntax := 0
		for _, r := range results {
			if q, ok := r["quality_score"].(float64); ok {
				sumQ += q
			}
			if t, ok := r["tps"].(float64); ok {
				sumTPS += t
			}
			if ok, _ := r["syntax_ok"].(bool); ok {
				passSyntax++
			}
		}
		n := float64(len(results))
		avgQ := math.Round(sumQ/n*10) / 10
		avgTPS := math.Round(sumTPS/n*10) / 10

		overallScore := "F"
		switch {
		case avgQ >= 9:
			overallScore = "S"
		case avgQ >= 7:
			overallScore = "A"
		case avgQ >= 5:
			overallScore = "B"
		case avgQ >= 3:
			overallScore = "C"
		}

		extraBytes, _ := json.Marshal(map[string]interface{}{
			"judge_model": judgeModel,
			"languages":   results,
		})

		judgeLabel := judgeModel
		if judgeModel == "same" {
			judgeLabel = model
		}

		run := CodeBenchmarkRun{
			ServerName:         activeSrv.Name,
			ServerURL:          activeSrv.URL,
			ModelName:          model,
			OllamaVersion:      ollamaVer,
			JudgeModel:         judgeLabel,
			Languages:          strings.Join(langs, ","),
			AvgQualityScore:    avgQ,
			AvgTPS:             avgTPS,
			LangsTotal:         len(results),
			LangsPassingSyntax: passSyntax,
			OverallScore:       overallScore,
			ExtraJSON:          string(extraBytes),
		}
		id, saveErr := SaveCodeBenchmarkRun(run)
		if saveErr != nil {
			c.SSEvent("error", fmt.Sprintf("Save failed: %v", saveErr))
			c.Writer.Flush()
			return false
		}

		emit(fmt.Sprintf("✓ Complete — Avg quality: %.1f/10 | Avg TPS: %.1f | Score: %s | Syntax: %d/%d", avgQ, avgTPS, overallScore, passSyntax, len(results)))

		emit("⏹ Unloading model from VRAM…")
		go func() {
			_ = client.UnloadModel(context.Background(), model)
			if judgeModel != "same" && judgeModel != "" && judgeModel != model {
				_ = client.UnloadModel(context.Background(), judgeModel)
			}
		}()

		passPct := 0.0
		if len(results) > 0 {
			passPct = float64(passSyntax) / float64(len(results)) * 100
		}
		LogActivity("benchmark", fmt.Sprintf("Code benchmark completed: %s — %.0f%% pass, %.1f TPS", model, passPct, avgTPS))
		doneBytes, _ := json.Marshal(map[string]interface{}{
			"id":                   id,
			"model_name":           model,
			"judge_model":          judgeLabel,
			"avg_quality_score":    avgQ,
			"avg_tps":              avgTPS,
			"langs_total":          len(results),
			"langs_passing_syntax": passSyntax,
			"overall_score":        overallScore,
			"extra_json":           string(extraBytes),
		})
		c.SSEvent("done", string(doneBytes))
		c.Writer.Flush()
		return false
	})
}

// runHallucinationSSEHandler streams a needle-in-a-haystack hallucination test.
func runHallucinationSSEHandler(c *gin.Context) {
	model := c.Query("model")
	if model == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "model required"})
		return
	}
	maxKStr := c.DefaultQuery("max_context_k", "32")
	maxK, _ := strconv.Atoi(maxKStr)
	if maxK <= 0 {
		maxK = 32
	}

	customFiller := strings.TrimSpace(c.Query("custom_filler"))
	fillerSource := "builtin"
	fillerUnit := hallucinationFillerUnit
	if customFiller != "" {
		fillerSource = "custom"
		fillerUnit = customFiller
		if len(fillerUnit) < 50 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "custom filler too short"})
			return
		}
	}

	activeSrv, err := GetActiveServer()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "No active Ollama server"})
		return
	}

	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("Transfer-Encoding", "chunked")

	client := NewOllamaClient(activeSrv)
	ctx := c.Request.Context()
	ollamaVer, _, _ := client.CheckStatus(ctx)

	sizes := contextSizesK(maxK)
	positions := []int{10, 50, 90}
	total := len(sizes) * len(positions)

	LogActivity("benchmark", fmt.Sprintf("Hallucination test started: %s (max %dk, %d cells)", model, maxK, total))

	warmupModel(ctx, client, model, 0, func(msg string) {
		c.SSEvent("log", msg)
		c.Writer.Flush()
	})

	buildPrompt := func(targetK, positionPct int) string {
		targetChars := targetK * 1000 * 4
		unitLen := len(fillerUnit)
		totalUnits := targetChars / unitLen
		if totalUnits < 2 {
			totalUnits = 2
		}
		insertAt := (totalUnits * positionPct) / 100

		var sb strings.Builder
		sb.WriteString("Read the following document carefully, then answer the question at the end.\n\n")
		for i := 0; i < totalUnits; i++ {
			if i == insertAt {
				sb.WriteString("[CLASSIFIED RECORD] ")
				sb.WriteString(hallucinationSecret)
				sb.WriteString(" [END RECORD]\n\n")
			}
			sb.WriteString(fillerUnit)
			sb.WriteString("\n\n")
		}
		sb.WriteString("\n\nQuestion: ")
		sb.WriteString(hallucinationQuestion)
		return sb.String()
	}

	c.Stream(func(w io.Writer) bool {
		defer func() {
			go client.UnloadModel(context.Background(), model)
		}()

		hemit := func(msg string) {
			c.SSEvent("status", msg)
			c.Writer.Flush()
		}

		hemit(fmt.Sprintf("Starting hallucination test: %s | max context: %dk | %d cells", model, maxK, total))

		type cell struct {
			ContextK        int     `json:"context_k"`
			PositionPct     int     `json:"position_pct"`
			Pass            bool    `json:"pass"`
			IsHallucination bool    `json:"is_hallucination"`
			Response        string  `json:"response"`
			TtftMs          float64 `json:"ttft_ms"`
			TotalMs         float64 `json:"total_ms"`
		}

		var cells []cell
		passed := 0
		hallucinated := 0
		done := 0

		for _, k := range sizes {
			for _, pos := range positions {
				select {
				case <-ctx.Done():
					c.SSEvent("error", "Cancelled")
					c.Writer.Flush()
					return false
				default:
				}

				done++
				hemit(fmt.Sprintf("[%d/%d] Context: %dk | Position: %d%%...", done, total, k, pos))

				prompt := buildPrompt(k, pos)
				numCtx := k * 1024

				req := GenerateRequest{
					Model:  model,
					Prompt: noThinkPrompt(model, prompt),
					Think:  thinkParam(model),
					Stream: true,
					Options: map[string]interface{}{
						"temperature": 0.0,
						"num_predict": 40,
						"num_ctx":     numCtx,
					},
				}

				start := time.Now()
				stream, streamErr := client.StreamGenerate(ctx, req)
				if streamErr != nil {
					hemit(fmt.Sprintf("  ✗ Failed: %v", streamErr))
					cells = append(cells, cell{ContextK: k, PositionPct: pos, Pass: false, Response: "ERROR: " + streamErr.Error()})
					continue
				}
				hemit(fmt.Sprintf("  Waiting for first token..."))

				var firstTok time.Duration
				var gotFirst bool
				var respBuilder strings.Builder

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
							hemit(fmt.Sprintf("  ⚡ First token: %.0fms", float64(firstTok.Milliseconds())))
						}
						respBuilder.WriteString(chunk.Response)
					}
				}
				_ = stream.Close()
				totalMs := float64(time.Since(start).Milliseconds())

				response := strings.TrimSpace(respBuilder.String())
				pass := strings.Contains(strings.ToUpper(response), strings.ToUpper(hallucinationNeedle))

				isHallucination := false
				if !pass && response != "" {
					lower := strings.ToLower(response)
					refusals := []string{"don't know", "cannot find", "not mentioned", "no mention",
						"not provided", "not in the", "unable to find", "i don't", "cannot determine",
						"not specified", "not contain", "no information"}
					isRefusal := false
					for _, r := range refusals {
						if strings.Contains(lower, r) {
							isRefusal = true
							break
						}
					}
					if !isRefusal {
						isHallucination = true
					}
				}

				if pass {
					passed++
				}
				if isHallucination {
					hallucinated++
				}

				status := "PASS"
				if !pass {
					if isHallucination {
						status = "HALLUCINATION"
					} else {
						status = "REFUSAL"
					}
				}
				hemit(fmt.Sprintf("  %s → %q", status, response))

				ttftMs := float64(firstTok.Milliseconds())
				cellBytes, _ := json.Marshal(map[string]interface{}{
					"context_k":        k,
					"position_pct":     pos,
					"pass":             pass,
					"is_hallucination": isHallucination,
					"response":         response,
					"ttft_ms":          ttftMs,
					"total_ms":         totalMs,
				})
				c.SSEvent("cell", string(cellBytes))
				c.Writer.Flush()

				cells = append(cells, cell{
					ContextK: k, PositionPct: pos,
					Pass: pass, IsHallucination: isHallucination,
					Response: response, TtftMs: ttftMs, TotalMs: totalMs,
				})
			}
		}

		recallPct := 0.0
		hallPct := 0.0
		if total > 0 {
			recallPct = math.Round(float64(passed)/float64(total)*1000) / 10
			hallPct = math.Round(float64(hallucinated)/float64(total)*1000) / 10
		}

		extraBytes, _ := json.Marshal(map[string]interface{}{
			"needle":        hallucinationNeedle,
			"filler_source": fillerSource,
			"cells":         cells,
			"total_cells":   total,
			"passed":        passed,
			"hallucinated":  hallucinated,
		})

		halRun := HallucinationRun{
			ServerName:       activeSrv.Name,
			ServerURL:        activeSrv.URL,
			ModelName:        model,
			OllamaVersion:    ollamaVer,
			MaxContextK:      maxK,
			FillerSource:     fillerSource,
			RecallPct:        recallPct,
			HallucinationPct: hallPct,
			ExtraJSON:        string(extraBytes),
		}
		id, saveErr := SaveHallucinationRun(halRun)
		if saveErr != nil {
			c.SSEvent("error", fmt.Sprintf("Save failed: %v", saveErr))
			c.Writer.Flush()
			return false
		}

		LogActivity("benchmark", fmt.Sprintf("Hallucination test completed: %s — Recall: %.1f%%, Halluc: %.1f%%", model, recallPct, hallPct))
		hemit(fmt.Sprintf("✓ Complete — Recall: %.1f%% | Hallucinations: %.1f%%", recallPct, hallPct))

		hemit("⏹ Unloading model from VRAM…")
		go client.UnloadModel(context.Background(), model)

		doneBytes, _ := json.Marshal(map[string]interface{}{
			"id":                id,
			"model_name":        model,
			"max_context_k":     maxK,
			"recall_pct":        recallPct,
			"hallucination_pct": hallPct,
			"extra_json":        string(extraBytes),
		})
		c.SSEvent("done", string(doneBytes))
		c.Writer.Flush()
		return false
	})
}

func getCodeBenchmarksHandler(c *gin.Context) {
	runs, err := GetCodeBenchmarkRuns()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if runs == nil {
		runs = []CodeBenchmarkRun{}
	}
	c.JSON(http.StatusOK, runs)
}

type ModelBenchSummaryEntry struct {
	StdGrade    string  `json:"std_grade,omitempty"`
	StdTPS      float64 `json:"std_tps,omitempty"`
	StdType     string  `json:"std_type,omitempty"`
	CodeGrade   string  `json:"code_grade,omitempty"`
	CodeQuality float64 `json:"code_quality,omitempty"`
	HalluRecall float64 `json:"hallu_recall,omitempty"`
	HalluCtxK   int     `json:"hallu_ctx_k,omitempty"`
}

var gradeRank = map[string]int{"S": 6, "A": 5, "B": 4, "C": 3, "D": 2, "F": 1, "": 0}

func modelBenchSummaryHandler(c *gin.Context) {
	out := make(map[string]ModelBenchSummaryEntry)

	if resp, err := GetGroupedBenchmarks("all", "model", "asc"); err == nil && resp != nil {
		for _, g := range resp.Groups {
			cur := out[g.ModelName]
			if gradeRank[g.DisplayScore] > gradeRank[cur.StdGrade] {
				cur.StdGrade = g.DisplayScore
				cur.StdTPS = g.SummaryRun.Tps
				cur.StdType = g.BenchmarkType
			}
			out[g.ModelName] = cur
		}
	}

	if runs, err := GetCodeBenchmarkRuns(); err == nil {
		for _, r := range runs {
			cur := out[r.ModelName]
			if gradeRank[r.OverallScore] > gradeRank[cur.CodeGrade] {
				cur.CodeGrade = r.OverallScore
				cur.CodeQuality = r.AvgQualityScore
			}
			out[r.ModelName] = cur
		}
	}

	if runs, err := GetHallucinationRuns(); err == nil {
		for _, r := range runs {
			cur := out[r.ModelName]
			if r.RecallPct > cur.HalluRecall ||
				(r.RecallPct == cur.HalluRecall && r.MaxContextK > cur.HalluCtxK) {
				cur.HalluRecall = r.RecallPct
				cur.HalluCtxK = r.MaxContextK
			}
			out[r.ModelName] = cur
		}
	}

	c.JSON(http.StatusOK, out)
}

func deleteCodeBenchmarkHandler(c *gin.Context) {
	idStr := c.Param("id")
	var id int64
	if _, err := fmt.Sscanf(idStr, "%d", &id); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	if err := DeleteCodeBenchmarkRun(id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func getHallucinationRunsHandler(c *gin.Context) {
	runs, err := GetHallucinationRuns()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if runs == nil {
		runs = []HallucinationRun{}
	}
	c.JSON(http.StatusOK, runs)
}

func deleteHallucinationRunHandler(c *gin.Context) {
	idStr := c.Param("id")
	var id int64
	if _, err := fmt.Sscanf(idStr, "%d", &id); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	if err := DeleteHallucinationRun(id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
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

	ollamaVer, _, _ := client.CheckStatus(ctx)

	c.Stream(func(w io.Writer) bool {
		c.SSEvent("status", fmt.Sprintf("Initializing %s benchmark for %s...", strings.ToUpper(benchType), model))

		warmupModel(ctx, client, model, 0, func(msg string) {
			c.SSEvent("status", msg)
			c.Writer.Flush()
		})

		var (
			avgTtft, avgTps, avgLatency float64
			extraJSON                   string
			saveErr                     error
			id                          int64
		)

		switch benchType {

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

		case "embedding":
			var cps float64
			cps, extraJSON, saveErr = runEmbeddingBenchmarkRun(ctx, client, model, func(msg string) {
				c.SSEvent("status", msg)
			})
			if saveErr != nil {
				c.SSEvent("error", fmt.Sprintf("Embedding benchmark failed: %v", saveErr))
				return false
			}
			avgTps = cps
			avgTtft = 0
			avgLatency = 0

		case "longctx":
			var runErr error
			avgTps, avgTtft, avgLatency, extraJSON, runErr = runLongCtxBenchmarkRun(ctx, client, model, func(msg string) {
				c.SSEvent("status", msg)
			})
			if runErr != nil {
				c.SSEvent("error", fmt.Sprintf("Long-context benchmark failed: %v", runErr))
				return false
			}

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

		default:
			benchType = "standard"
			prompts := []string{
				"Explain the difference between TCP and UDP in one simple sentence.",
				"Write a short Python function that checks if a string is a palindrome.",
				"Briefly explain the theory of relativity to a 10-year-old in one paragraph.",
			}
			var sumTtft, sumTps, sumLatency float64
			var greetingDetected bool
			runs := 0
			for i, prompt := range prompts {
				c.SSEvent("status", fmt.Sprintf("Prompt %d/3: %q", i+1, prompt))
				ttft, tps, lat, respHead, runErr := runBenchmarkForPrompt(ctx, client, model, prompt, func(msg string) {
					c.SSEvent("status", msg)
				})
				if runErr != nil {
					c.SSEvent("error", fmt.Sprintf("Prompt %d failed: %v", i+1, runErr))
					continue
				}
				if i == 0 && isGreetingResponse(respHead) {
					greetingDetected = true
					c.SSEvent("status", "⚠ CHAT_MODEL — model responded with a greeting instead of answering the prompt.")
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
			if greetingDetected {
				flagBytes, _ := json.Marshal(map[string]interface{}{"flags": []string{"chat_model"}})
				extraJSON = string(flagBytes)
			}
		}

		id, saveErr = SaveBenchmark(model, activeSrv.Name, activeSrv.URL, benchType, extraJSON, ollamaVer, avgTtft, avgTps, avgLatency)
		if saveErr != nil {
			c.SSEvent("error", fmt.Sprintf("Failed to save benchmark: %v", saveErr))
			return false
		}
		if cullErr := CullBenchmarks(model, activeSrv.URL, benchType, 3); cullErr != nil {
			log.Printf("Warning: failed to cull benchmarks: %v", cullErr)
		}

		LogActivity("benchmark", fmt.Sprintf("Benchmark completed: %s [%s] — %.1f TPS", model, strings.ToUpper(benchType), avgTps))
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

func deleteAllBenchmarksHandler(c *gin.Context) {
	if _, err := DB.Exec("DELETE FROM benchmarks"); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	LogActivity("system", "All benchmark results cleared")
	c.JSON(http.StatusOK, gin.H{"message": "All benchmark results deleted."})
}

func getServerByID(id string) (Server, error) {
	for _, s := range GetServers() {
		if s.ID == id {
			return s, nil
		}
	}
	return Server{}, fmt.Errorf("server %q not found", id)
}

func nodeModelsHandler(c *gin.Context) {
	idsParam := strings.TrimSpace(c.Query("ids"))
	allowed := map[string]bool{}
	if idsParam != "" && idsParam != "all" {
		for _, id := range strings.Split(idsParam, ",") {
			if id = strings.TrimSpace(id); id != "" {
				allowed[id] = true
			}
		}
	}

	result := map[string]interface{}{}
	nodeModelMu.RLock()
	for nodeID, entry := range nodeModelCache {
		if len(allowed) > 0 && !allowed[nodeID] {
			continue
		}
		result[nodeID] = entry.models
	}
	nodeModelMu.RUnlock()

	c.JSON(http.StatusOK, gin.H{"servers": result})
}

func nodeVsNodeBenchmarkHandler(c *gin.Context) {
	model := c.Query("model")
	nodeAID := c.Query("nodeA")
	nodeBID := c.Query("nodeB")
	benchType := c.DefaultQuery("type", "standard")
	doPull := c.Query("pull") == "true"

	if model == "" || nodeAID == "" || nodeBID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "model, nodeA, and nodeB are required"})
		return
	}
	if nodeAID == nodeBID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "nodeA and nodeB must be different servers"})
		return
	}
	nodeA, errA := getServerByID(nodeAID)
	if errA != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "nodeA: " + errA.Error()})
		return
	}
	nodeB, errB := getServerByID(nodeBID)
	if errB != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "nodeB: " + errB.Error()})
		return
	}

	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("Transfer-Encoding", "chunked")

	ctx := c.Request.Context()
	LogActivity("benchmark", fmt.Sprintf("Node-vs-Node: %s [%s] — %s vs %s", model, benchType, nodeA.Name, nodeB.Name))

	type NvNResult struct {
		NodeName string  `json:"node_name"`
		NodeURL  string  `json:"node_url"`
		NodeID   string  `json:"node_id"`
		TTFT     float64 `json:"ttft_ms"`
		TPS      float64 `json:"tps"`
		Latency  float64 `json:"avg_latency_ms"`
		Extra    string  `json:"extra_json"`
		BenchID  int64   `json:"bench_id"`
		HasError bool    `json:"has_error"`
		ErrMsg   string  `json:"error,omitempty"`
	}

	c.Stream(func(w io.Writer) bool {
		emit := func(node, msg string) {
			data, _ := json.Marshal(map[string]string{"node": node, "message": msg})
			c.SSEvent("log", string(data))
			c.Writer.Flush()
		}

		ensureModel := func(srv Server, label string) bool {
			client := NewOllamaClient(srv)
			list, err := client.ListModels(ctx)
			if err != nil {
				emit(label, "⚠ Cannot reach node: "+err.Error())
				return false
			}
			for _, m := range list {
				if m.Name == model {
					emit(label, "✓ Model available")
					return true
				}
			}
			if !doPull {
				emit(label, "✗ Model not found — enable Auto-Pull to pull it automatically")
				return false
			}
			emit(label, fmt.Sprintf("Pulling %s...", model))
			stream, pullErr := client.StreamPullModel(ctx, model)
			if pullErr != nil {
				emit(label, "Pull failed: "+pullErr.Error())
				return false
			}
			defer stream.Close()
			lastPct := -1
			_ = ParsePullProgress(stream, func(p PullProgress) bool {
				pct := 0
				if p.Total > 0 {
					pct = int(float64(p.Completed) / float64(p.Total) * 100)
				}
				if pct != lastPct && pct%10 == 0 {
					emit(label, fmt.Sprintf("Pulling %d%%", pct))
					lastPct = pct
				}
				return true
			})
			invalidateNodeModelCache(srv.ID)
			emit(label, "✓ Pull complete")
			return true
		}

		runNode := func(srv Server, label string) NvNResult {
			res := NvNResult{NodeName: srv.Name, NodeURL: srv.URL, NodeID: srv.ID}
			client := NewOllamaClient(srv)
			nodeVer, _, _ := client.CheckStatus(ctx)
			logFn := func(msg string) { emit(label, msg) }
			emit(label, fmt.Sprintf("Running %s benchmark...", strings.ToUpper(benchType)))

			var runErr error
			switch benchType {
			case "embedding":
				cps, extra, e := runEmbeddingBenchmarkRun(ctx, client, model, logFn)
				res.TPS = cps; res.Extra = extra; runErr = e
			case "longctx":
				avg, ttft, lat, extra, e := runLongCtxBenchmarkRun(ctx, client, model, logFn)
				res.TPS = avg; res.TTFT = ttft; res.Latency = lat; res.Extra = extra; runErr = e
			case "reasoning":
				_, _, ttft, tps, lat, extra, e := runReasoningBenchmarkRun(ctx, client, model, logFn)
				res.TTFT = ttft; res.TPS = tps; res.Latency = lat; res.Extra = extra; runErr = e
			default:
				prompt := "Explain the difference between machine learning and traditional programming in 3 sentences."
				ttft, tps, lat, _, e := runBenchmarkForPrompt(ctx, client, model, prompt, logFn)
				res.TTFT = ttft; res.TPS = tps; res.Latency = lat; runErr = e
			}
			if runErr != nil {
				res.HasError = true; res.ErrMsg = runErr.Error()
				emit(label, "✗ Failed: "+runErr.Error())
				return res
			}
			id, _ := SaveBenchmark(model, srv.Name, srv.URL, benchType, res.Extra, nodeVer, res.TTFT, res.TPS, res.Latency)
			if id > 0 {
				res.BenchID = id
				_ = CullBenchmarks(model, srv.URL, benchType, 5)
			}
			emit(label, fmt.Sprintf("✓ %.1f TPS  •  %.0f ms TTFT  •  %.0f ms latency", res.TPS, res.TTFT, res.Latency))
			return res
		}

		okA := ensureModel(nodeA, "Node A")
		okB := ensureModel(nodeB, "Node B")

		var resA, resB NvNResult
		if okA {
			resA = runNode(nodeA, "Node A")
		} else {
			resA = NvNResult{NodeName: nodeA.Name, NodeURL: nodeA.URL, NodeID: nodeA.ID, HasError: true, ErrMsg: "model unavailable"}
		}
		if okB {
			resB = runNode(nodeB, "Node B")
		} else {
			resB = NvNResult{NodeName: nodeB.Name, NodeURL: nodeB.URL, NodeID: nodeB.ID, HasError: true, ErrMsg: "model unavailable"}
		}

		winnerID, winnerName := func() (string, string) {
			if resA.HasError || resB.HasError {
				return "", ""
			}
			scoreA, scoreB := 0, 0
			if resA.TPS > resB.TPS { scoreA++ } else if resB.TPS > resA.TPS { scoreB++ }
			if resA.TTFT > 0 && resB.TTFT > 0 {
				if resA.TTFT < resB.TTFT { scoreA++ } else if resB.TTFT < resA.TTFT { scoreB++ }
			}
			if resA.Latency > 0 && resB.Latency > 0 {
				if resA.Latency < resB.Latency { scoreA++ } else if resB.Latency < resA.Latency { scoreB++ }
			}
			if scoreA > scoreB { return resA.NodeID, resA.NodeName }
			if scoreB > scoreA { return resB.NodeID, resB.NodeName }
			return "", ""
		}()

		_, _ = SaveNvnMatch(NvnMatch{
			ModelName:  model,
			BenchType:  benchType,
			NodeAID:    resA.NodeID, NodeAName: resA.NodeName,
			NodeBID:    resB.NodeID, NodeBName: resB.NodeName,
			WinnerID:   winnerID, WinnerName: winnerName,
			NodeATPS:   resA.TPS, NodeBTPS: resB.TPS,
			NodeATTFT:  resA.TTFT, NodeBTTFT: resB.TTFT,
			NodeALat:   resA.Latency, NodeBLat: resB.Latency,
			NodeAError: resA.HasError, NodeBError: resB.HasError,
		})

		payload, _ := json.Marshal(map[string]interface{}{
			"model": model, "type": benchType,
			"node_a": resA, "node_b": resB,
		})
		c.SSEvent("result", string(payload))
		c.SSEvent("done", "Node comparison complete")
		c.Writer.Flush()
		return false
	})
}

func deleteNvnMatchHandler(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	if err := DeleteNvnMatch(id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func nvnLeaderboardHandler(c *gin.Context) {
	entries, err := GetNvnLeaderboard()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if entries == nil {
		entries = []NvnLeaderboardEntry{}
	}
	c.JSON(http.StatusOK, entries)
}

func nvnMatchesHandler(c *gin.Context) {
	nodeID := c.Query("nodeId")
	matches, err := GetNvnMatches(nodeID, 100)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if matches == nil {
		matches = []NvnMatch{}
	}
	c.JSON(http.StatusOK, matches)
}

func cullOldBenchmarks(model, benchType string) {
	activeSrv, err := GetActiveServer()
	if err != nil {
		return
	}
	_ = CullBenchmarks(model, activeSrv.URL, benchType, 3)
}

func extractJSONBlock(s string) string {
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start >= 0 && end > start {
		return s[start : end+1]
	}
	return s
}

var toolUseDefs = []map[string]interface{}{
	{"type": "function", "function": map[string]interface{}{
		"name":        "get_weather",
		"description": "Get the current weather for a location",
		"parameters": map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"location": map[string]interface{}{"type": "string", "description": "City name"},
			},
			"required": []string{"location"},
		},
	}},
	{"type": "function", "function": map[string]interface{}{
		"name":        "calculate",
		"description": "Perform arithmetic calculations",
		"parameters": map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"expression": map[string]interface{}{"type": "string", "description": "Math expression to evaluate"},
			},
			"required": []string{"expression"},
		},
	}},
	{"type": "function", "function": map[string]interface{}{
		"name":        "search",
		"description": "Search the web for information",
		"parameters": map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"query": map[string]interface{}{"type": "string", "description": "Search query string"},
			},
			"required": []string{"query"},
		},
	}},
}

type toolUseCase struct {
	Prompt    string
	WantTool  string
	WantParam map[string]string
}

var toolUseCases = []toolUseCase{
	{"What's the weather like in Oslo right now?", "get_weather", map[string]string{"location": "oslo"}},
	{"What is 127 multiplied by 43?", "calculate", map[string]string{"expression": "127"}},
	{"Search for the latest Go 1.24 release notes", "search", map[string]string{"query": "go"}},
	{"I need weather info for Tokyo.", "get_weather", map[string]string{"location": "tokyo"}},
	{"Calculate the square root of 1764.", "calculate", map[string]string{"expression": "1764"}},
	{"Find information about the Ollama open-source project.", "search", map[string]string{"query": "ollama"}},
	{"What is the temperature in Berlin today?", "get_weather", map[string]string{"location": "berlin"}},
	{"What is 99 divided by 9?", "calculate", map[string]string{"expression": "99"}},
}

func runToolUseBenchmarkRun(ctx context.Context, client *OllamaClient, model string, logFunc func(string)) (correct, total int, extraJSON string, err error) {
	for i, tc := range toolUseCases {
		if ctx.Err() != nil {
			return correct, total, "", ctx.Err()
		}
		logFunc(fmt.Sprintf("Tool case %d/%d: %s", i+1, len(toolUseCases), tc.Prompt))
		req := ChatRequest{
			Model: model,
			Messages: []ChatMessage{
				{Role: "user", Content: tc.Prompt},
			},
			Stream:  false,
			Tools:   toolUseDefs,
			Options: map[string]interface{}{"temperature": 0.0, "num_predict": 500},
		}
		resp, callErr := client.ChatWithTools(ctx, req)
		if callErr != nil {
			logFunc(fmt.Sprintf("  ✗ request error: %v", callErr))
			total++
			continue
		}
		total++
		if len(resp.Message.ToolCalls) == 0 {
			logFunc(fmt.Sprintf("  ✗ no tool call returned (content: %q)", resp.Message.Content))
			continue
		}
		tc0 := resp.Message.ToolCalls[0]
		toolNameOk := strings.EqualFold(tc0.Function.Name, tc.WantTool)
		paramsOk := true
		for k, wantSubstr := range tc.WantParam {
			var argVal string
			if v, ok := tc0.Function.Arguments[k]; ok {
				argVal = strings.ToLower(fmt.Sprintf("%v", v))
			}
			if !strings.Contains(argVal, strings.ToLower(wantSubstr)) {
				paramsOk = false
				break
			}
		}
		if toolNameOk && paramsOk {
			correct++
			logFunc(fmt.Sprintf("  ✓ called %s correctly", tc0.Function.Name))
		} else if toolNameOk {
			logFunc(fmt.Sprintf("  ~ called right tool (%s) but wrong params", tc0.Function.Name))
		} else {
			logFunc(fmt.Sprintf("  ✗ called %s (expected %s)", tc0.Function.Name, tc.WantTool))
		}
	}
	acc := 0.0
	if total > 0 {
		acc = float64(correct) / float64(total) * 100.0
	}
	ej, _ := json.Marshal(map[string]interface{}{
		"accuracy_pct": acc,
		"correct":      correct,
		"total":        total,
	})
	return correct, total, string(ej), nil
}

func runToolUseBenchmarkSSEHandler(c *gin.Context) {
	model := c.Query("model")
	if model == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "model parameter required"})
		return
	}
	activeSrv, err := GetActiveServer()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "No active server"})
		return
	}
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("Transfer-Encoding", "chunked")
	LogActivity("benchmark", fmt.Sprintf("Tool-use benchmark started: %s", model))
	client := NewOllamaClient(activeSrv)
	ctx := c.Request.Context()
	ollamaVer, _, _ := client.CheckStatus(ctx)
	c.Stream(func(w io.Writer) bool {
		emit := func(msg string) {
			c.SSEvent("status", msg)
			c.Writer.Flush()
		}
		emit(fmt.Sprintf("Initializing tool-use benchmark for %s…", model))
		warmupModel(ctx, client, model, 0, emit)
		correct, total, extraJSON, runErr := runToolUseBenchmarkRun(ctx, client, model, emit)
		if runErr != nil {
			c.SSEvent("error", runErr.Error())
			return false
		}
		acc := 0.0
		if total > 0 {
			acc = float64(correct) / float64(total) * 100.0
		}
		emit(fmt.Sprintf("[COMPLETED] %d/%d correct — %.0f%% accuracy", correct, total, acc))
		id, saveErr := SaveBenchmark(model, activeSrv.Name, activeSrv.URL, "tool_use", extraJSON, ollamaVer, 0, 0, 0)
		if saveErr != nil {
			emit(fmt.Sprintf("Warning: failed to save result: %v", saveErr))
		}
		cullOldBenchmarks(model, "tool_use")
		LogActivity("benchmark", fmt.Sprintf("Tool-use benchmark completed: %s — %.0f%% accuracy", model, acc))
		c.SSEvent("done", fmt.Sprintf(`{"id":%d,"model":%q,"bench_type":"tool_use","accuracy_pct":%.1f}`, id, model, acc))
		return false
	})
}

type jsonOutputCase struct {
	Prompt         string
	RequiredFields []string
}

var jsonOutputCases = []jsonOutputCase{
	{`Return a JSON object with fields: name (string), age (integer), active (boolean).`, []string{"name", "age", "active"}},
	{`Return a JSON object with fields: title (string), author (string), year (integer).`, []string{"title", "author", "year"}},
	{`Return nested JSON: an object with a "user" key containing "id" (integer) and "email" (string).`, []string{"user"}},
	{`Return a JSON object representing a 3D point with numeric fields x, y, z.`, []string{"x", "y", "z"}},
	{`Return a JSON object with: items (array of strings), count (integer).`, []string{"items", "count"}},
	{`Return a JSON object with: status (string), code (integer), message (string).`, []string{"status", "code", "message"}},
}

func runJSONOutputBenchmarkRun(ctx context.Context, client *OllamaClient, model string, logFunc func(string)) (valid, total int, extraJSON string, err error) {
	for i, tc := range jsonOutputCases {
		if ctx.Err() != nil {
			return valid, total, "", ctx.Err()
		}
		logFunc(fmt.Sprintf("JSON case %d/%d…", i+1, len(jsonOutputCases)))
		req := ChatRequest{
			Model:    model,
			Messages: []ChatMessage{{Role: "user", Content: tc.Prompt}},
			Stream:   false,
			Format:   "json",
			Options:  map[string]interface{}{"temperature": 0.0, "num_predict": 300},
		}
		resp, callErr := client.ChatWithTools(ctx, req)
		total++
		if callErr != nil {
			logFunc(fmt.Sprintf("  ✗ request error: %v", callErr))
			continue
		}
		content := strings.TrimSpace(resp.Message.Content)
		var parsed map[string]interface{}
		if json.Unmarshal([]byte(content), &parsed) != nil {
			logFunc(fmt.Sprintf("  ✗ invalid JSON"))
			continue
		}
		allFields := true
		for _, f := range tc.RequiredFields {
			if _, ok := parsed[f]; !ok {
				allFields = false
				logFunc(fmt.Sprintf("  ~ valid JSON but missing field %q", f))
				break
			}
		}
		if allFields {
			valid++
			logFunc(fmt.Sprintf("  ✓ valid JSON with all required fields"))
		}
	}
	acc := 0.0
	if total > 0 {
		acc = float64(valid) / float64(total) * 100.0
	}
	ej, _ := json.Marshal(map[string]interface{}{
		"accuracy_pct": acc,
		"valid":        valid,
		"total":        total,
	})
	return valid, total, string(ej), nil
}

func runJSONOutputBenchmarkSSEHandler(c *gin.Context) {
	model := c.Query("model")
	if model == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "model parameter required"})
		return
	}
	activeSrv, err := GetActiveServer()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "No active server"})
		return
	}
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("Transfer-Encoding", "chunked")
	LogActivity("benchmark", fmt.Sprintf("JSON-output benchmark started: %s", model))
	client := NewOllamaClient(activeSrv)
	ctx := c.Request.Context()
	ollamaVer, _, _ := client.CheckStatus(ctx)
	c.Stream(func(w io.Writer) bool {
		emit := func(msg string) {
			c.SSEvent("status", msg)
			c.Writer.Flush()
		}
		emit(fmt.Sprintf("Initializing JSON-output benchmark for %s…", model))
		warmupModel(ctx, client, model, 0, emit)
		valid, total, extraJSON, runErr := runJSONOutputBenchmarkRun(ctx, client, model, emit)
		if runErr != nil {
			c.SSEvent("error", runErr.Error())
			return false
		}
		acc := 0.0
		if total > 0 {
			acc = float64(valid) / float64(total) * 100.0
		}
		emit(fmt.Sprintf("[COMPLETED] %d/%d valid JSON — %.0f%% accuracy", valid, total, acc))
		id, saveErr := SaveBenchmark(model, activeSrv.Name, activeSrv.URL, "json_output", extraJSON, ollamaVer, 0, 0, 0)
		if saveErr != nil {
			emit(fmt.Sprintf("Warning: failed to save result: %v", saveErr))
		}
		cullOldBenchmarks(model, "json_output")
		LogActivity("benchmark", fmt.Sprintf("JSON-output benchmark completed: %s — %.0f%% accuracy", model, acc))
		c.SSEvent("done", fmt.Sprintf(`{"id":%d,"model":%q,"bench_type":"json_output","accuracy_pct":%.1f}`, id, model, acc))
		return false
	})
}

type instructionCase struct {
	Prompt      string
	JudgePrompt string
}

var instructionCases = []instructionCase{
	{
		"List exactly 5 programming languages, one per line, no explanations.",
		`Does the following response contain EXACTLY 5 programming languages listed one per line with no extra explanations or surrounding text? Reply with JSON only: {"compliant": true/false, "reason": "one sentence"}`,
	},
	{
		"Count from 1 to 5. Each number on its own line. Nothing else.",
		`Does the following response contain ONLY the numbers 1 through 5 each on its own line, with absolutely no other content? Reply with JSON only: {"compliant": true/false, "reason": "one sentence"}`,
	},
	{
		"Translate 'Hello, how are you?' into French. Reply with ONLY the translation, nothing else.",
		`Does the following response contain ONLY a French translation of 'Hello, how are you?' with no explanations or extra text? Reply with JSON only: {"compliant": true/false, "reason": "one sentence"}`,
	},
	{
		"What is 2+2? Reply with a single digit only.",
		`Does the following response contain ONLY the single digit 4 with no other content whatsoever? Reply with JSON only: {"compliant": true/false, "reason": "one sentence"}`,
	},
	{
		"Write exactly 3 bullet points about the Go programming language. Use '-' as the bullet character. No intro, no conclusion.",
		`Does the following response contain EXACTLY 3 bullet points using '-' as the bullet character, with no introduction, conclusion, or extra text? Reply with JSON only: {"compliant": true/false, "reason": "one sentence"}`,
	},
	{
		"Name the 3 primary colors. Comma-separated on one line. No other text.",
		`Does the following response contain ONLY 3 primary colors listed comma-separated on a single line with no other text? Reply with JSON only: {"compliant": true/false, "reason": "one sentence"}`,
	},
}

func runInstructionFollowBenchmarkRun(ctx context.Context, client *OllamaClient, model, judgeModel string, logFunc func(string)) (compliant, total int, extraJSON string, err error) {
	if judgeModel == "" || judgeModel == "same" {
		judgeModel = model
	}
	for i, tc := range instructionCases {
		if ctx.Err() != nil {
			return compliant, total, "", ctx.Err()
		}
		logFunc(fmt.Sprintf("Instruction case %d/%d…", i+1, len(instructionCases)))
		genReq := GenerateRequest{
			Model:  model,
			Prompt: noThinkPrompt(model, tc.Prompt),
			Think:  thinkParam(model),
			Stream: true,
			Options: map[string]interface{}{"temperature": 0.0, "num_predict": 300},
		}
		var sb strings.Builder
		streamErr := client.GenerateStream(ctx, genReq, func(tok string) { sb.WriteString(tok) })
		total++
		if streamErr != nil {
			logFunc(fmt.Sprintf("  ✗ generation error: %v", streamErr))
			continue
		}
		response := strings.TrimSpace(sb.String())
		if isRefusalResponse(response) {
			logFunc("  ✗ model refused the prompt")
			continue
		}
		judgePromptFull := tc.JudgePrompt + "\n\nResponse to evaluate:\n" + response
		judgeReq := GenerateRequest{
			Model:  judgeModel,
			Prompt: noThinkPrompt(judgeModel, judgePromptFull),
			System: judgeSystemPrompt,
			Think:  thinkParam(judgeModel),
			Stream: true,
			Options: map[string]interface{}{"temperature": 0.0, "num_predict": 200},
		}
		var jsb strings.Builder
		_ = client.GenerateStream(ctx, judgeReq, func(tok string) { jsb.WriteString(tok) })
		judgeRaw := extractJSONBlock(jsb.String())
		var judgeResult struct {
			Compliant bool   `json:"compliant"`
			Reason    string `json:"reason"`
		}
		if json.Unmarshal([]byte(judgeRaw), &judgeResult) == nil && judgeResult.Compliant {
			compliant++
			logFunc(fmt.Sprintf("  ✓ compliant"))
		} else {
			logFunc(fmt.Sprintf("  ✗ not compliant: %s", judgeResult.Reason))
		}
	}
	acc := 0.0
	if total > 0 {
		acc = float64(compliant) / float64(total) * 100.0
	}
	ej, _ := json.Marshal(map[string]interface{}{
		"accuracy_pct": acc,
		"compliant":    compliant,
		"total":        total,
	})
	return compliant, total, string(ej), nil
}

func runInstructionFollowBenchmarkSSEHandler(c *gin.Context) {
	model := c.Query("model")
	if model == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "model parameter required"})
		return
	}
	judgeModel := c.DefaultQuery("judge_model", "same")
	activeSrv, err := GetActiveServer()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "No active server"})
		return
	}
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("Transfer-Encoding", "chunked")
	LogActivity("benchmark", fmt.Sprintf("Instruction-follow benchmark started: %s (judge: %s)", model, judgeModel))
	client := NewOllamaClient(activeSrv)
	ctx := c.Request.Context()
	ollamaVer, _, _ := client.CheckStatus(ctx)
	c.Stream(func(w io.Writer) bool {
		emit := func(msg string) {
			c.SSEvent("status", msg)
			c.Writer.Flush()
		}
		emit(fmt.Sprintf("Initializing instruction-follow benchmark for %s (judge: %s)…", model, judgeModel))
		warmupModel(ctx, client, model, 0, emit)
		if judgeModel != "same" && judgeModel != model {
			warmupModel(ctx, client, judgeModel, 0, emit)
		}
		compliant, total, extraJSON, runErr := runInstructionFollowBenchmarkRun(ctx, client, model, judgeModel, emit)
		if runErr != nil {
			c.SSEvent("error", runErr.Error())
			return false
		}
		acc := 0.0
		if total > 0 {
			acc = float64(compliant) / float64(total) * 100.0
		}
		emit(fmt.Sprintf("[COMPLETED] %d/%d compliant — %.0f%% accuracy", compliant, total, acc))
		id, saveErr := SaveBenchmark(model, activeSrv.Name, activeSrv.URL, "instruction_follow", extraJSON, ollamaVer, 0, 0, 0)
		if saveErr != nil {
			emit(fmt.Sprintf("Warning: failed to save result: %v", saveErr))
		}
		cullOldBenchmarks(model, "instruction_follow")
		LogActivity("benchmark", fmt.Sprintf("Instruction-follow benchmark completed: %s — %.0f%% accuracy", model, acc))
		c.SSEvent("done", fmt.Sprintf(`{"id":%d,"model":%q,"bench_type":"instruction_follow","accuracy_pct":%.1f}`, id, model, acc))
		return false
	})
}

// checkCodeSyntax does a fast static syntax check for supported languages.
// Returns (syntaxOK, message). Languages without a CLI checker return (true, "skipped").
func checkCodeSyntax(lang, code string) (bool, string) {
	writeTemp := func(ext, content string) (string, func(), error) {
		f, err := os.CreateTemp("", "code_check_*"+ext)
		if err != nil {
			return "", func() {}, err
		}
		if _, err := f.WriteString(content); err != nil {
			_ = f.Close()
			return "", func() {}, err
		}
		_ = f.Close()
		return f.Name(), func() { _ = os.Remove(f.Name()) }, nil
	}

	runCmd := func(timeout time.Duration, name string, args ...string) (bool, string) {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
		if err != nil {
			return false, stripANSI(strings.TrimSpace(string(out)))
		}
		return true, ""
	}

	switch lang {
	case "go":
		src := code
		if !strings.HasPrefix(strings.TrimSpace(src), "package ") {
			src = "package main\n" + src
		}
		_, parseErr := goparser.ParseFile(token.NewFileSet(), "", src, goparser.AllErrors)
		if parseErr != nil {
			return false, parseErr.Error()
		}
		return true, ""

	case "python":
		path, cleanup, err := writeTemp(".py", code)
		if err != nil {
			return true, "check unavailable"
		}
		defer cleanup()
		return runCmd(5*time.Second, "python3", "-m", "py_compile", path)

	case "javascript", "node":
		path, cleanup, err := writeTemp(".js", code)
		if err != nil {
			return true, "check unavailable"
		}
		defer cleanup()
		return runCmd(5*time.Second, "node", "--check", path)

	case "typescript":
		path, cleanup, err := writeTemp(".ts", normalizeNodeImports(code))
		if err != nil {
			return true, "check unavailable"
		}
		defer cleanup()
		if _, lookErr := exec.LookPath("deno"); lookErr == nil {
			return runCmd(15*time.Second, "deno", "check", "--no-remote", path)
		}
		return true, "skipped"

	case "bash":
		path, cleanup, err := writeTemp(".sh", code)
		if err != nil {
			return true, "check unavailable"
		}
		defer cleanup()
		return runCmd(5*time.Second, "bash", "-n", path)

	case "sh":
		path, cleanup, err := writeTemp(".sh", code)
		if err != nil {
			return true, "check unavailable"
		}
		defer cleanup()
		return runCmd(5*time.Second, "sh", "-n", path)

	case "php":
		path, cleanup, err := writeTemp(".php", code)
		if err != nil {
			return true, "check unavailable"
		}
		defer cleanup()
		return runCmd(5*time.Second, "php", "-l", path)

	case "ruby":
		path, cleanup, err := writeTemp(".rb", code)
		if err != nil {
			return true, "check unavailable"
		}
		defer cleanup()
		return runCmd(5*time.Second, "ruby", "-c", path)

	case "rust":
		if _, lookErr := exec.LookPath("rustc"); lookErr != nil {
			return true, "skipped"
		}
		path, cleanup, err := writeTemp(".rs", code)
		if err != nil {
			return true, "check unavailable"
		}
		defer cleanup()
		outDir, dirErr := os.MkdirTemp("", "neurollama_rustc_*")
		if dirErr != nil {
			return true, "check unavailable"
		}
		defer func() { _ = os.RemoveAll(outDir) }()
		return runCmd(20*time.Second, "rustc", "--edition", "2021", "--crate-type", "lib", "--emit=metadata",
			"-A", "dead_code", "-A", "unused", "--out-dir", outDir, path)

	case "c":
		compiler := ""
		for _, cc := range []string{"gcc", "clang", "cc"} {
			if _, lookErr := exec.LookPath(cc); lookErr == nil {
				compiler = cc
				break
			}
		}
		if compiler == "" {
			return true, "skipped"
		}
		preamble := "#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n"
		path, cleanup, err := writeTemp(".c", preamble+code)
		if err != nil {
			return true, "check unavailable"
		}
		defer cleanup()
		return runCmd(10*time.Second, compiler, "-fsyntax-only", "-std=c99", "-x", "c", path)

	case "sql":
		if _, lookErr := exec.LookPath("sqlfluff"); lookErr != nil {
			return true, "skipped"
		}
		path, cleanup, err := writeTemp(".sql", code)
		if err != nil {
			return true, "check unavailable"
		}
		defer cleanup()
		return runCmd(15*time.Second, "sqlfluff", "parse", "--dialect", "ansi", path)

	default:
		return true, "skipped"
	}
}

