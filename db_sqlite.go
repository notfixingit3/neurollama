package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

	_ "github.com/glebarez/go-sqlite"
)

var DB *sql.DB

type Chat struct {
	ID               int64   `json:"id"`
	Title            string  `json:"title"`
	Model            string  `json:"model"`
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
	CreatedAt        string  `json:"created_at"`
}

type Preset struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Content   string `json:"content"`
	CreatedAt string `json:"created_at"`
}

type Setting struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type SchedulerLog struct {
	ID        int64  `json:"id"`
	ModelName string `json:"model_name"`
	Status    string `json:"status"`
	Message   string `json:"message"`
	CreatedAt string `json:"created_at"`
}

type Benchmark struct {
	ID             int64   `json:"id"`
	ModelName      string  `json:"model_name"`
	ServerName     string  `json:"server_name"`
	ServerURL      string  `json:"server_url"`
	BenchmarkType  string  `json:"benchmark_type"`
	TtftMs         float64 `json:"ttft_ms"`
	Tps            float64 `json:"tps"`
	AvgLatencyMs   float64 `json:"avg_latency_ms"`
	ReasoningScore string  `json:"reasoning_score"`
	ExtraJSON      string  `json:"extra_json"`
	Notes          string  `json:"notes"`
	CreatedAt      string  `json:"created_at"`
}

// BenchmarkSummaryRun is an averaged view of all runs in a group.
// It carries the same numeric fields that the leaderboard rendering code needs,
// plus the min/max range data for variance indicators — so the browser can
// render without doing any arithmetic.
type BenchmarkSummaryRun struct {
	TtftMs       float64  `json:"ttft_ms"`
	Tps          float64  `json:"tps"`
	AvgLatencyMs float64  `json:"avg_latency_ms"`
	ExtraJSON    string   `json:"extra_json"`   // JSON with avg chunks_per_sec / accuracy_pct / degradation_pct
	IsAvg        bool     `json:"is_avg"`        // true when run_count > 1
	MinTps       float64  `json:"min_tps"`
	MaxTps       float64  `json:"max_tps"`
	MinCps       *float64 `json:"min_chunks_per_sec"`
	MaxCps       *float64 `json:"max_chunks_per_sec"`
	MinAcc       *float64 `json:"min_accuracy_pct"`
	MaxAcc       *float64 `json:"max_accuracy_pct"`
}

// BenchmarkWithScore wraps a raw Benchmark run with a pre-resolved display
// score so the browser never needs to call autoScore() for leaderboard rows.
type BenchmarkWithScore struct {
	Benchmark
	DisplayScore string `json:"display_score"`
	IsAutoScore  bool   `json:"is_auto_score"`
}

// BenchmarkGroup is a set of runs for one model+type+server combination,
// with all aggregation pre-computed by the server.
type BenchmarkGroup struct {
	ModelName       string               `json:"model_name"`
	BenchmarkType   string               `json:"benchmark_type"`
	ServerName      string               `json:"server_name"`
	ServerURL       string               `json:"server_url"`
	RunCount        int                  `json:"run_count"`
	LatestID        int64                `json:"latest_id"`
	LatestScore     string               `json:"latest_score"`     // raw DB value
	LatestNotes     string               `json:"latest_notes"`
	LatestCreatedAt string               `json:"latest_created_at"`
	DisplayScore    string               `json:"display_score"`    // resolved: stored or auto-computed
	IsAutoScore     bool                 `json:"is_auto_score"`
	SummaryRun      BenchmarkSummaryRun  `json:"summary_run"`
	Runs            []BenchmarkWithScore `json:"runs"`
}

// TypeBest captures the best-performing group for one benchmark type.
type TypeBest struct {
	BenchmarkType string  `json:"benchmark_type"`
	ModelName     string  `json:"model_name"`
	Metric        float64 `json:"metric"`
	Label         string  `json:"label"`
}

// BenchmarkLeaderboardStats contains the aggregated data for the stats bar.
type BenchmarkLeaderboardStats struct {
	TotalRuns         int            `json:"total_runs"`
	UniqueModels      int            `json:"unique_models"`
	TypeBests         []TypeBest     `json:"type_bests"`
	ScoreDistribution map[string]int `json:"score_distribution"`
}

// BenchmarkGroupedResponse is returned by GET /api/benchmarks/grouped.
type BenchmarkGroupedResponse struct {
	Groups []BenchmarkGroup          `json:"groups"`
	Stats  BenchmarkLeaderboardStats `json:"stats"`
}

type OptimizerRun struct {
	ID              int64   `json:"id"`
	ServerName      string  `json:"server_name"`
	ServerURL       string  `json:"server_url"`
	ModelName       string  `json:"model_name"`
	Temperature     float64 `json:"temperature"`
	TopP            float64 `json:"top_p"`
	TopK            int     `json:"top_k"`
	TtftMs          float64 `json:"ttft_ms"`
	Tps             float64 `json:"tps"`
	AvgLatencyMs    float64 `json:"avg_latency_ms"`
	PromptUsed      string  `json:"prompt_used"`
	ResponsePreview string  `json:"response_preview"`
	CreatedAt       string  `json:"created_at"`
}

type RAGDocument struct {
	ID             int64  `json:"id"`
	Name           string `json:"name"`
	EmbeddingModel string `json:"embedding_model"`
	ChunkCount     int    `json:"chunk_count"`
	CreatedAt      string `json:"created_at"`
	ProbePhrase    string `json:"probe_phrase"` // first ~200 chars of chunk 0 for the TEST button
}

type RAGChunk struct {
	ID         int64     `json:"id"`
	DocID      int64     `json:"doc_id"`
	ChunkIndex int       `json:"chunk_index"`
	Content    string    `json:"content"`
	Embedding  []float64 `json:"embedding"`
}

type RAGChunkWithDocInfo struct {
	ChunkID      int64     `json:"chunk_id"`
	DocumentID   int64     `json:"document_id"`
	DocumentName string    `json:"document_name"`
	ChunkIndex   int       `json:"chunk_index"`
	Content      string    `json:"content"`
	Embedding    []float64 `json:"embedding"`
}

// InitDB initializes the SQLite database connection and runs migrations
func InitDB(dbPath string) error {
	// Create directory if it doesn't exist
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("failed to create database directory: %w", err)
	}

	var err error
	DB, err = sql.Open("sqlite", dbPath)
	if err != nil {
		return fmt.Errorf("failed to open database: %w", err)
	}

	// Set connection limits
	DB.SetMaxOpenConns(1) // SQLite works best with a single writer to avoid locked errors

	if err := migrate(); err != nil {
		return fmt.Errorf("migration failed: %w", err)
	}

	if err := seedDefaultPresets(); err != nil {
		log.Printf("Warning: failed to seed default presets: %v", err)
	}

	log.Printf("SQLite database initialized successfully at %s", dbPath)
	return nil
}

func columnExists(tableName, columnName string) bool {
	rows, err := DB.Query(fmt.Sprintf("PRAGMA table_info(%s)", tableName))
	if err != nil {
		return false
	}
	defer func() { _ = rows.Close() }()

	for rows.Next() {
		var cid int
		var name string
		var typeStr string
		var notnull int
		var dfltValue sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &typeStr, &notnull, &dfltValue, &pk); err != nil {
			return false
		}
		if name == columnName {
			return true
		}
	}
	return false
}

func migrate() error {
	queries := []string{
		`CREATE TABLE IF NOT EXISTS chats (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			title TEXT NOT NULL,
			model TEXT NOT NULL,
			system_prompt TEXT NOT NULL,
			temperature REAL NOT NULL,
			num_ctx INTEGER NOT NULL,
			top_k INTEGER NOT NULL DEFAULT 40,
			top_p REAL NOT NULL DEFAULT 0.9,
			repeat_penalty REAL NOT NULL DEFAULT 1.1,
			seed INTEGER,
			min_p REAL NOT NULL DEFAULT 0.0,
			presence_penalty REAL NOT NULL DEFAULT 0.0,
			frequency_penalty REAL NOT NULL DEFAULT 0.0,
			num_predict INTEGER NOT NULL DEFAULT -1,
			num_gpu INTEGER NOT NULL DEFAULT -1,
			num_thread INTEGER NOT NULL DEFAULT -1,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);`,
		`CREATE TABLE IF NOT EXISTS messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			chat_id INTEGER NOT NULL,
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			images TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
		);`,
		`CREATE TABLE IF NOT EXISTS presets (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT UNIQUE NOT NULL,
			content TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);`,
		`CREATE TABLE IF NOT EXISTS settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS scheduler_logs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			model_name TEXT NOT NULL,
			status TEXT NOT NULL,
			message TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);`,
		`CREATE TABLE IF NOT EXISTS benchmarks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			model_name TEXT NOT NULL,
			ttft_ms REAL NOT NULL,
			tps REAL NOT NULL,
			avg_latency_ms REAL NOT NULL,
			reasoning_score TEXT NOT NULL DEFAULT 'Pending',
			notes TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);`,
		`CREATE TABLE IF NOT EXISTS optimizer_runs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			server_name TEXT NOT NULL,
			server_url TEXT NOT NULL,
			model_name TEXT NOT NULL,
			temperature REAL NOT NULL,
			top_p REAL NOT NULL,
			top_k INTEGER NOT NULL,
			ttft_ms REAL NOT NULL,
			tps REAL NOT NULL,
			avg_latency_ms REAL NOT NULL,
			prompt_used TEXT NOT NULL,
			response_preview TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);`,
		`CREATE TABLE IF NOT EXISTS rag_documents (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			embedding_model TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);`,
		`CREATE TABLE IF NOT EXISTS rag_chunks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			document_id INTEGER NOT NULL,
			chunk_index INTEGER NOT NULL,
			content TEXT NOT NULL,
			embedding TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY(document_id) REFERENCES rag_documents(id) ON DELETE CASCADE
		);`,
	}

	for _, q := range queries {
		if _, err := DB.Exec(q); err != nil {
			return err
		}
	}

	// Seed default settings if they don't exist
	defaultSettings := map[string]string{
		"update_schedule":   "off",
		"last_update_check": "",
	}
	for k, v := range defaultSettings {
		_, err := DB.Exec("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", k, v)
		if err != nil {
			return fmt.Errorf("failed to seed setting %s: %w", k, err)
		}
	}

	// Dynamic migrations for existing databases
	alterQueries := []struct {
		table  string
		column string
		query  string
	}{
		{"chats", "top_k", "ALTER TABLE chats ADD COLUMN top_k INTEGER NOT NULL DEFAULT 40"},
		{"chats", "top_p", "ALTER TABLE chats ADD COLUMN top_p REAL NOT NULL DEFAULT 0.9"},
		{"chats", "repeat_penalty", "ALTER TABLE chats ADD COLUMN repeat_penalty REAL NOT NULL DEFAULT 1.1"},
		{"chats", "seed", "ALTER TABLE chats ADD COLUMN seed INTEGER"},
		{"chats", "min_p", "ALTER TABLE chats ADD COLUMN min_p REAL NOT NULL DEFAULT 0.0"},
		{"chats", "presence_penalty", "ALTER TABLE chats ADD COLUMN presence_penalty REAL NOT NULL DEFAULT 0.0"},
		{"chats", "frequency_penalty", "ALTER TABLE chats ADD COLUMN frequency_penalty REAL NOT NULL DEFAULT 0.0"},
		{"chats", "num_predict", "ALTER TABLE chats ADD COLUMN num_predict INTEGER NOT NULL DEFAULT -1"},
		{"chats", "num_gpu", "ALTER TABLE chats ADD COLUMN num_gpu INTEGER NOT NULL DEFAULT -1"},
		{"chats", "num_thread", "ALTER TABLE chats ADD COLUMN num_thread INTEGER NOT NULL DEFAULT -1"},
		{"messages", "images", "ALTER TABLE messages ADD COLUMN images TEXT"},
		{"benchmarks", "server_name",    "ALTER TABLE benchmarks ADD COLUMN server_name TEXT NOT NULL DEFAULT ''"},
		{"benchmarks", "server_url",     "ALTER TABLE benchmarks ADD COLUMN server_url TEXT NOT NULL DEFAULT ''"},
		{"benchmarks", "benchmark_type", "ALTER TABLE benchmarks ADD COLUMN benchmark_type TEXT NOT NULL DEFAULT 'standard'"},
		{"benchmarks", "extra_json",     "ALTER TABLE benchmarks ADD COLUMN extra_json TEXT NOT NULL DEFAULT ''"},
	}

	for _, alter := range alterQueries {
		if !columnExists(alter.table, alter.column) {
			log.Printf("Adding column %s to %s table", alter.column, alter.table)
			if _, err := DB.Exec(alter.query); err != nil {
				return fmt.Errorf("failed to add column %s: %w", alter.column, err)
			}
		}
	}

	return nil
}

func seedDefaultPresets() error {
	var count int
	err := DB.QueryRow("SELECT COUNT(*) FROM presets").Scan(&count)
	if err != nil {
		return err
	}

	if count > 0 {
		return nil // Already seeded
	}

	defaults := []struct {
		Name    string
		Content string
	}{
		{
			Name:    "General Assistant",
			Content: "You are a helpful, friendly, and knowledgeable AI assistant.",
		},
		{
			Name:    "Code Expert",
			Content: "You are an expert software engineer. Provide clean, efficient, readable, and well-commented code. Explain your design choices briefly.",
		},
		{
			Name:    "System Architect",
			Content: "You are a senior system architect. Analyze system requirements, design robust microservices architectures, and describe component designs, APIs, and data models.",
		},
		{
			Name:    "Copywriter",
			Content: "You are a creative copywriter. Write engaging, persuasive, and grammatically perfect marketing copy, blog posts, or social media content tailored to the requested audience.",
		},
	}

	tx, err := DB.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }() // no-op after Commit

	stmt, err := tx.Prepare("INSERT INTO presets (name, content) VALUES (?, ?)")
	if err != nil {
		return err
	}
	defer func() { _ = stmt.Close() }()

	for _, d := range defaults {
		if _, err := stmt.Exec(d.Name, d.Content); err != nil {
			return err
		}
	}

	return tx.Commit()
}

// Chats DB Helpers

func GetChats() ([]Chat, error) {
	rows, err := DB.Query("SELECT id, title, model, system_prompt, temperature, num_ctx, top_k, top_p, repeat_penalty, seed, min_p, presence_penalty, frequency_penalty, num_predict, num_gpu, num_thread, datetime(created_at, 'localtime') FROM chats ORDER BY id DESC")
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var chats []Chat
	for rows.Next() {
		var c Chat
		if err := rows.Scan(&c.ID, &c.Title, &c.Model, &c.SystemPrompt, &c.Temperature, &c.NumCtx, &c.TopK, &c.TopP, &c.RepeatPenalty, &c.Seed, &c.MinP, &c.PresencePenalty, &c.FrequencyPenalty, &c.NumPredict, &c.NumGPU, &c.NumThread, &c.CreatedAt); err != nil {
			return nil, err
		}
		chats = append(chats, c)
	}
	return chats, nil
}

func GetChat(id int64) (*Chat, error) {
	var c Chat
	err := DB.QueryRow("SELECT id, title, model, system_prompt, temperature, num_ctx, top_k, top_p, repeat_penalty, seed, min_p, presence_penalty, frequency_penalty, num_predict, num_gpu, num_thread, datetime(created_at, 'localtime') FROM chats WHERE id = ?", id).
		Scan(&c.ID, &c.Title, &c.Model, &c.SystemPrompt, &c.Temperature, &c.NumCtx, &c.TopK, &c.TopP, &c.RepeatPenalty, &c.Seed, &c.MinP, &c.PresencePenalty, &c.FrequencyPenalty, &c.NumPredict, &c.NumGPU, &c.NumThread, &c.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func CreateChat(title, model, systemPrompt string, temp float64, ctx int, topK int, topP float64, repeatPenalty float64, seed *int, minP float64, presencePenalty float64, frequencyPenalty float64, numPredict int, numGPU int, numThread int) (int64, error) {
	res, err := DB.Exec("INSERT INTO chats (title, model, system_prompt, temperature, num_ctx, top_k, top_p, repeat_penalty, seed, min_p, presence_penalty, frequency_penalty, num_predict, num_gpu, num_thread) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		title, model, systemPrompt, temp, ctx, topK, topP, repeatPenalty, seed, minP, presencePenalty, frequencyPenalty, numPredict, numGPU, numThread)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func UpdateChatTitle(id int64, title string) error {
	_, err := DB.Exec("UPDATE chats SET title = ? WHERE id = ?", title, id)
	return err
}

func UpdateChatConfig(id int64, model, systemPrompt string, temp float64, ctx int, topK int, topP float64, repeatPenalty float64, seed *int, minP float64, presencePenalty float64, frequencyPenalty float64, numPredict int, numGPU int, numThread int) error {
	_, err := DB.Exec("UPDATE chats SET model = ?, system_prompt = ?, temperature = ?, num_ctx = ?, top_k = ?, top_p = ?, repeat_penalty = ?, seed = ?, min_p = ?, presence_penalty = ?, frequency_penalty = ?, num_predict = ?, num_gpu = ?, num_thread = ? WHERE id = ?",
		model, systemPrompt, temp, ctx, topK, topP, repeatPenalty, seed, minP, presencePenalty, frequencyPenalty, numPredict, numGPU, numThread, id)
	return err
}

func DeleteChat(id int64) error {
	tx, err := DB.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }() // no-op after Commit

	// Delete messages first (cascade on delete is declared, but it's good to execute explicit deletes for consistency)
	if _, err := tx.Exec("DELETE FROM messages WHERE chat_id = ?", id); err != nil {
		return err
	}

	if _, err := tx.Exec("DELETE FROM chats WHERE id = ?", id); err != nil {
		return err
	}

	return tx.Commit()
}

// Messages DB Helpers

func GetChatMessages(chatId int64) ([]ChatMessage, error) {
	rows, err := DB.Query("SELECT role, content, images FROM messages WHERE chat_id = ? ORDER BY id ASC", chatId)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var messages []ChatMessage
	for rows.Next() {
		var m ChatMessage
		var imagesStr sql.NullString
		if err := rows.Scan(&m.Role, &m.Content, &imagesStr); err != nil {
			return nil, err
		}
		if imagesStr.Valid && imagesStr.String != "" {
			var imgs []string
			if err := json.Unmarshal([]byte(imagesStr.String), &imgs); err == nil {
				m.Images = imgs
			}
		}
		messages = append(messages, m)
	}
	return messages, nil
}

func SaveChatMessage(chatId int64, role, content string, images []string) error {
	var imagesVal interface{}
	if len(images) > 0 {
		bytes, err := json.Marshal(images)
		if err == nil {
			imagesVal = string(bytes)
		}
	}
	_, err := DB.Exec("INSERT INTO messages (chat_id, role, content, images) VALUES (?, ?, ?, ?)", chatId, role, content, imagesVal)
	return err
}

// Presets DB Helpers

func GetPresets() ([]Preset, error) {
	rows, err := DB.Query("SELECT id, name, content, datetime(created_at, 'localtime') FROM presets ORDER BY name ASC")
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var presets []Preset
	for rows.Next() {
		var p Preset
		if err := rows.Scan(&p.ID, &p.Name, &p.Content, &p.CreatedAt); err != nil {
			return nil, err
		}
		presets = append(presets, p)
	}
	return presets, nil
}

func CreatePreset(name, content string) (int64, error) {
	res, err := DB.Exec("INSERT INTO presets (name, content) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET content=excluded.content", name, content)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func DeletePreset(id int64) error {
	_, err := DB.Exec("DELETE FROM presets WHERE id = ?", id)
	return err
}

// Settings Helpers

func GetSettings() (map[string]string, error) {
	rows, err := DB.Query("SELECT key, value FROM settings")
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	settings := make(map[string]string)
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		settings[k] = v
	}
	return settings, nil
}

func UpdateSetting(key, val string) error {
	_, err := DB.Exec("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", key, val)
	return err
}

// Scheduler Log Helpers

func GetSchedulerLogs() ([]SchedulerLog, error) {
	rows, err := DB.Query("SELECT id, model_name, status, message, datetime(created_at, 'localtime') FROM scheduler_logs ORDER BY id DESC LIMIT 100")
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var logs []SchedulerLog
	for rows.Next() {
		var l SchedulerLog
		if err := rows.Scan(&l.ID, &l.ModelName, &l.Status, &l.Message, &l.CreatedAt); err != nil {
			return nil, err
		}
		logs = append(logs, l)
	}
	return logs, nil
}

func LogScheduleAction(modelName, status, message string) error {
	_, err := DB.Exec("INSERT INTO scheduler_logs (model_name, status, message) VALUES (?, ?, ?)", modelName, status, message)
	return err
}

// Benchmark Helpers

func GetBenchmarks() ([]Benchmark, error) {
	rows, err := DB.Query(`SELECT id, model_name,
		COALESCE(server_name,''), COALESCE(server_url,''),
		COALESCE(benchmark_type,'standard'), COALESCE(extra_json,''),
		ttft_ms, tps, avg_latency_ms, reasoning_score, COALESCE(notes,''),
		datetime(created_at,'localtime')
		FROM benchmarks ORDER BY id DESC`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var list []Benchmark
	for rows.Next() {
		var b Benchmark
		if err := rows.Scan(
			&b.ID, &b.ModelName, &b.ServerName, &b.ServerURL,
			&b.BenchmarkType, &b.ExtraJSON,
			&b.TtftMs, &b.Tps, &b.AvgLatencyMs, &b.ReasoningScore,
			&b.Notes, &b.CreatedAt,
		); err != nil {
			return nil, err
		}
		list = append(list, b)
	}
	return list, nil
}

// benchmarkGroupKey identifies a unique model+type+server combination.
type benchmarkGroupKey struct{ model, btype, serverURL string }

// GetGroupedBenchmarks returns benchmark runs aggregated server-side so the
// browser only has to render, not compute. filter may be "all" or a specific
// benchmark type. sortCol and sortDir match the JS leaderboard sort controls.
func GetGroupedBenchmarks(filter, sortCol, sortDir string) (*BenchmarkGroupedResponse, error) {
	all, err := GetBenchmarks()
	if err != nil {
		return nil, err
	}

	// ── 1. Optional type filter ───────────────────────────────────────────────
	var rows []Benchmark
	for _, b := range all {
		if filter == "" || filter == "all" || b.BenchmarkType == filter {
			rows = append(rows, b)
		}
	}

	// ── 2. Group (GetBenchmarks returns newest-first, so each slice is already
	//        ordered that way — latest run is index 0). ────────────────────────
	type groupEntry struct {
		key  benchmarkGroupKey
		runs []Benchmark
	}
	groupMap := make(map[benchmarkGroupKey]*groupEntry)
	var groupOrder []benchmarkGroupKey

	for _, b := range rows {
		k := benchmarkGroupKey{b.ModelName, b.BenchmarkType, b.ServerURL}
		if _, ok := groupMap[k]; !ok {
			groupMap[k] = &groupEntry{key: k}
			groupOrder = append(groupOrder, k)
		}
		groupMap[k].runs = append(groupMap[k].runs, b)
	}

	// ── 3. Build BenchmarkGroup for each entry ────────────────────────────────
	scoreOrder := map[string]int{"S": 5, "A": 4, "B": 3, "C": 2, "F": 1}
	groups := make([]BenchmarkGroup, 0, len(groupOrder))

	for _, k := range groupOrder {
		entry := groupMap[k]
		runs := entry.runs
		latest := runs[0]

		summaryRun := buildGroupSummary(runs)
		displayScore, isAutoScore := resolveDisplayScore(latest, summaryRun)

		// Resolve display score for every individual run so sub-rows need no JS computation.
		runsWithScore := make([]BenchmarkWithScore, len(runs))
		for i, r := range runs {
			singleSummary := buildGroupSummary([]Benchmark{r})
			ds, isAuto := resolveDisplayScore(r, singleSummary)
			runsWithScore[i] = BenchmarkWithScore{Benchmark: r, DisplayScore: ds, IsAutoScore: isAuto}
		}

		groups = append(groups, BenchmarkGroup{
			ModelName:       k.model,
			BenchmarkType:   k.btype,
			ServerName:      latest.ServerName,
			ServerURL:       k.serverURL,
			RunCount:        len(runs),
			LatestID:        latest.ID,
			LatestScore:     latest.ReasoningScore,
			LatestNotes:     latest.Notes,
			LatestCreatedAt: latest.CreatedAt,
			DisplayScore:    displayScore,
			IsAutoScore:     isAutoScore,
			SummaryRun:      summaryRun,
			Runs:            runsWithScore,
		})
	}

	// ── 4. Sort groups ────────────────────────────────────────────────────────
	sort.SliceStable(groups, func(i, j int) bool {
		a, b := &groups[i], &groups[j]
		asc := sortDir == "asc"
		less := func(av, bv float64) bool {
			if asc {
				return av < bv
			}
			return av > bv
		}
		lessStr := func(av, bv string) bool {
			if asc {
				return av < bv
			}
			return av > bv
		}
		switch sortCol {
		case "model_name":
			return lessStr(strings.ToLower(a.ModelName), strings.ToLower(b.ModelName))
		case "server_name":
			return lessStr(strings.ToLower(a.ServerName), strings.ToLower(b.ServerName))
		case "tps":
			return less(a.SummaryRun.Tps, b.SummaryRun.Tps)
		case "ttft_ms":
			return less(a.SummaryRun.TtftMs, b.SummaryRun.TtftMs)
		case "avg_latency_ms":
			return less(a.SummaryRun.AvgLatencyMs, b.SummaryRun.AvgLatencyMs)
		case "score":
			return less(float64(scoreOrder[a.DisplayScore]), float64(scoreOrder[b.DisplayScore]))
		default: // "created_at" — groups are already newest-first from the DB query,
			// so this preserves insertion order for desc; reverse for asc.
			if asc {
				return i > j
			}
			return i < j
		}
	})

	// ── 5. Compute stats bar data ─────────────────────────────────────────────
	uniqueModels := make(map[string]struct{})
	for _, b := range rows {
		uniqueModels[b.ModelName] = struct{}{}
	}

	typeBestMap := make(map[string]*TypeBest)
	scoreDist := map[string]int{"S": 0, "A": 0, "B": 0, "C": 0, "F": 0}

	for i := range groups {
		g := &groups[i]

		// Per-type best
		var metric float64
		var label string
		switch g.BenchmarkType {
		case "embedding":
			var ex struct{ ChunksPerSec float64 `json:"chunks_per_sec"` }
			_ = json.Unmarshal([]byte(g.SummaryRun.ExtraJSON), &ex)
			metric = ex.ChunksPerSec
			label = fmt.Sprintf("%.1f ch/s", metric)
		case "reasoning":
			var ex struct{ AccuracyPct float64 `json:"accuracy_pct"` }
			_ = json.Unmarshal([]byte(g.SummaryRun.ExtraJSON), &ex)
			metric = ex.AccuracyPct
			label = fmt.Sprintf("%.0f%%", metric)
		default:
			metric = g.SummaryRun.Tps
			label = fmt.Sprintf("%.1f TPS", metric)
		}
		prev, ok := typeBestMap[g.BenchmarkType]
		if !ok || metric > prev.Metric {
			typeBestMap[g.BenchmarkType] = &TypeBest{
				BenchmarkType: g.BenchmarkType,
				ModelName:     g.ModelName,
				Metric:        metric,
				Label:         label,
			}
		}

		// Score distribution
		sc := g.DisplayScore
		if _, ok := scoreDist[sc]; ok {
			scoreDist[sc]++
		}
	}

	typeBests := make([]TypeBest, 0, len(typeBestMap))
	for _, tb := range typeBestMap {
		typeBests = append(typeBests, *tb)
	}
	sort.Slice(typeBests, func(i, j int) bool {
		return typeBests[i].BenchmarkType < typeBests[j].BenchmarkType
	})

	return &BenchmarkGroupedResponse{
		Groups: groups,
		Stats: BenchmarkLeaderboardStats{
			TotalRuns:         len(rows),
			UniqueModels:      len(uniqueModels),
			TypeBests:         typeBests,
			ScoreDistribution: scoreDist,
		},
	}, nil
}

// buildGroupSummary computes an averaged BenchmarkSummaryRun from all runs in a group.
func buildGroupSummary(runs []Benchmark) BenchmarkSummaryRun {
	n := float64(len(runs))
	if n == 0 {
		return BenchmarkSummaryRun{}
	}
	if len(runs) == 1 {
		r := runs[0]
		return BenchmarkSummaryRun{
			TtftMs:       r.TtftMs,
			Tps:          r.Tps,
			AvgLatencyMs: r.AvgLatencyMs,
			ExtraJSON:    r.ExtraJSON,
			IsAvg:        false,
			MinTps:       r.Tps,
			MaxTps:       r.Tps,
		}
	}

	var sumTtft, sumTps, sumLat float64
	minTps, maxTps := runs[0].Tps, runs[0].Tps

	var sumCps, sumAcc, sumDeg float64
	var hasCps, hasAcc, hasDeg bool
	var minCps, maxCps, minAcc, maxAcc float64

	for _, r := range runs {
		sumTtft += r.TtftMs
		sumTps += r.Tps
		sumLat += r.AvgLatencyMs
		if r.Tps < minTps { minTps = r.Tps }
		if r.Tps > maxTps { maxTps = r.Tps }

		var ex struct {
			ChunksPerSec   *float64 `json:"chunks_per_sec"`
			AccuracyPct    *float64 `json:"accuracy_pct"`
			DegradationPct *float64 `json:"degradation_pct"`
		}
		if r.ExtraJSON != "" {
			_ = json.Unmarshal([]byte(r.ExtraJSON), &ex)
		}
		if ex.ChunksPerSec != nil {
			v := *ex.ChunksPerSec
			if !hasCps { minCps, maxCps = v, v } else { if v < minCps { minCps = v }; if v > maxCps { maxCps = v } }
			sumCps += v; hasCps = true
		}
		if ex.AccuracyPct != nil {
			v := *ex.AccuracyPct
			if !hasAcc { minAcc, maxAcc = v, v } else { if v < minAcc { minAcc = v }; if v > maxAcc { maxAcc = v } }
			sumAcc += v; hasAcc = true
		}
		if ex.DegradationPct != nil {
			sumDeg += *ex.DegradationPct; hasDeg = true
		}
	}

	// Build avg extra_json
	avgExtra := make(map[string]interface{})
	if hasCps { avgExtra["chunks_per_sec"] = sumCps / n }
	if hasAcc { avgExtra["accuracy_pct"] = sumAcc / n }
	if hasDeg { avgExtra["degradation_pct"] = sumDeg / n }
	extraBytes, _ := json.Marshal(avgExtra)

	s := BenchmarkSummaryRun{
		TtftMs:       sumTtft / n,
		Tps:          sumTps / n,
		AvgLatencyMs: sumLat / n,
		ExtraJSON:    string(extraBytes),
		IsAvg:        true,
		MinTps:       minTps,
		MaxTps:       maxTps,
	}
	if hasCps { avgCps := sumCps / n; minC := minCps; maxC := maxCps; s.MinCps = &minC; s.MaxCps = &maxC; _ = avgCps }
	if hasAcc { avgAcc := sumAcc / n; minA := minAcc; maxA := maxAcc; s.MinAcc = &minA; s.MaxAcc = &maxA; _ = avgAcc }
	return s
}

// resolveDisplayScore determines the score to show on the leaderboard.
// If the stored score is blank or "Pending" and wasn't set by auto-scoring,
// it computes one on the fly from the group's averaged summary.
func resolveDisplayScore(latest Benchmark, summary BenchmarkSummaryRun) (score string, isAuto bool) {
	raw := latest.ReasoningScore
	isPending := raw == "" || raw == "Pending"
	isAutoNote := latest.Notes == "auto"

	if isPending && !isAutoNote {
		// Legacy run that predates auto-scoring — compute from avg summary
		score = computeBenchmarkScore(latest.BenchmarkType, summary.Tps, summary.ExtraJSON)
		return score, true
	}
	if raw == "" {
		raw = "F"
	}
	return raw, isAutoNote
}

// speedTier returns a performance tier based on tokens-per-second.
func speedTier(tps float64) string {
	switch {
	case tps >= 40:
		return "S"
	case tps >= 25:
		return "A"
	case tps >= 12:
		return "B"
	case tps >= 4:
		return "C"
	default:
		return "F"
	}
}

// computeBenchmarkScore picks the right scoring method per benchmark type.
func computeBenchmarkScore(benchType string, tps float64, extraJSON string) string {
	switch benchType {
	case "reasoning":
		var d struct {
			AccuracyPct float64 `json:"accuracy_pct"`
		}
		_ = json.Unmarshal([]byte(extraJSON), &d)
		switch {
		case d.AccuracyPct >= 100:
			return "S"
		case d.AccuracyPct >= 80:
			return "A"
		case d.AccuracyPct >= 60:
			return "B"
		case d.AccuracyPct >= 40:
			return "C"
		default:
			return "F"
		}
	case "embedding":
		// tps field holds chunks/sec
		switch {
		case tps >= 50:
			return "S"
		case tps >= 20:
			return "A"
		case tps >= 8:
			return "B"
		case tps >= 2:
			return "C"
		default:
			return "F"
		}
	default:
		return speedTier(tps)
	}
}

func SaveBenchmark(modelName, serverName, serverURL, benchmarkType, extraJSON string, ttft, tps, avgLatency float64) (int64, error) {
	if benchmarkType == "" {
		benchmarkType = "standard"
	}
	score := computeBenchmarkScore(benchmarkType, tps, extraJSON)
	res, err := DB.Exec(
		`INSERT INTO benchmarks
		 (model_name, server_name, server_url, benchmark_type, extra_json, ttft_ms, tps, avg_latency_ms, reasoning_score)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		modelName, serverName, serverURL, benchmarkType, extraJSON, ttft, tps, avgLatency, score,
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// CullBenchmarks deletes the oldest runs for a given model+server+type combo,
// keeping only the most recent keepLast rows. Call after SaveBenchmark.
func CullBenchmarks(modelName, serverURL, benchType string, keepLast int) error {
	_, err := DB.Exec(`
		DELETE FROM benchmarks
		WHERE model_name = ? AND COALESCE(server_url,'') = ? AND COALESCE(benchmark_type,'standard') = ?
		  AND id NOT IN (
		    SELECT id FROM benchmarks
		    WHERE model_name = ? AND COALESCE(server_url,'') = ? AND COALESCE(benchmark_type,'standard') = ?
		    ORDER BY id DESC
		    LIMIT ?
		  )`,
		modelName, serverURL, benchType,
		modelName, serverURL, benchType,
		keepLast,
	)
	return err
}

func UpdateBenchmarkScore(id int64, score, notes string) error {
	_, err := DB.Exec("UPDATE benchmarks SET reasoning_score = ?, notes = ? WHERE id = ?", score, notes, id)
	return err
}

func DeleteBenchmark(id int64) error {
	_, err := DB.Exec("DELETE FROM benchmarks WHERE id = ?", id)
	return err
}

// Chat Context Pruning Helper

func PruneChatMessages(chatID int64, keepCount int) error {
	var count int
	err := DB.QueryRow("SELECT COUNT(*) FROM messages WHERE chat_id = ?", chatID).Scan(&count)
	if err != nil {
		return err
	}

	if count <= keepCount {
		return nil
	}

	limit := count - keepCount
	_, err = DB.Exec(`
		DELETE FROM messages 
		WHERE chat_id = ? 
		AND id IN (
			SELECT id FROM messages 
			WHERE chat_id = ? 
			ORDER BY id ASC 
			LIMIT ?
		)
	`, chatID, chatID, limit)
	return err
}

// Optimizer Run Helpers

func SaveOptimizerRun(serverName, serverUrl, modelName string, temp, topP float64, topK int, ttft, tps, avgLatency float64, prompt, preview string) (int64, error) {
	res, err := DB.Exec(`
		INSERT INTO optimizer_runs 
		(server_name, server_url, model_name, temperature, top_p, top_k, ttft_ms, tps, avg_latency_ms, prompt_used, response_preview) 
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		serverName, serverUrl, modelName, temp, topP, topK, ttft, tps, avgLatency, prompt, preview)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func GetOptimizerRuns() ([]OptimizerRun, error) {
	rows, err := DB.Query("SELECT id, server_name, server_url, model_name, temperature, top_p, top_k, ttft_ms, tps, avg_latency_ms, prompt_used, response_preview, datetime(created_at, 'localtime') FROM optimizer_runs ORDER BY id DESC")
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var list []OptimizerRun
	for rows.Next() {
		var r OptimizerRun
		if err := rows.Scan(&r.ID, &r.ServerName, &r.ServerURL, &r.ModelName, &r.Temperature, &r.TopP, &r.TopK, &r.TtftMs, &r.Tps, &r.AvgLatencyMs, &r.PromptUsed, &r.ResponsePreview, &r.CreatedAt); err != nil {
			return nil, err
		}
		list = append(list, r)
	}
	return list, nil
}

func DeleteOptimizerRun(id int64) error {
	_, err := DB.Exec("DELETE FROM optimizer_runs WHERE id = ?", id)
	return err
}

// OptimizerRunGroup is a set of optimizer runs sharing the same
// server+model+hyperparameter combination, newest-first, capped at 3.
type OptimizerRunGroup struct {
	ServerName  string         `json:"server_name"`
	ServerURL   string         `json:"server_url"`
	ModelName   string         `json:"model_name"`
	Temperature float64        `json:"temperature"`
	TopP        float64        `json:"top_p"`
	TopK        int            `json:"top_k"`
	Runs        []OptimizerRun `json:"runs"`
}

// GetGroupedOptimizerRuns groups runs by server+model+hyperparams and caps
// each group at the 3 most recent runs, so the browser only renders.
func GetGroupedOptimizerRuns() ([]OptimizerRunGroup, error) {
	all, err := GetOptimizerRuns() // already newest-first
	if err != nil {
		return nil, err
	}

	type groupKey struct {
		serverURL, model string
		temp             float64
		topP             float64
		topK             int
	}
	groupMap := make(map[groupKey]*OptimizerRunGroup)
	var order []groupKey

	for _, r := range all {
		k := groupKey{r.ServerURL, r.ModelName, r.Temperature, r.TopP, r.TopK}
		if _, ok := groupMap[k]; !ok {
			groupMap[k] = &OptimizerRunGroup{
				ServerName:  r.ServerName,
				ServerURL:   r.ServerURL,
				ModelName:   r.ModelName,
				Temperature: r.Temperature,
				TopP:        r.TopP,
				TopK:        r.TopK,
			}
			order = append(order, k)
		}
		g := groupMap[k]
		if len(g.Runs) < 3 { // keep last 3 per group
			g.Runs = append(g.Runs, r)
		}
	}

	result := make([]OptimizerRunGroup, 0, len(order))
	for _, k := range order {
		result = append(result, *groupMap[k])
	}
	return result, nil
}

// RAG Helper Functions

func SaveRAGDocument(name string, embeddingModel string, chunks []RAGChunk) (int64, error) {
	tx, err := DB.Begin()
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }() // no-op after Commit

	res, err := tx.Exec("INSERT INTO rag_documents (name, embedding_model) VALUES (?, ?)", name, embeddingModel)
	if err != nil {
		return 0, err
	}

	docID, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}

	for _, chunk := range chunks {
		embeddingJSON, err := json.Marshal(chunk.Embedding)
		if err != nil {
			return 0, fmt.Errorf("failed to marshal embedding: %w", err)
		}

		_, err = tx.Exec(`
			INSERT INTO rag_chunks (document_id, chunk_index, content, embedding)
			VALUES (?, ?, ?, ?)`,
			docID, chunk.ChunkIndex, chunk.Content, string(embeddingJSON))
		if err != nil {
			return 0, err
		}
	}

	if err := tx.Commit(); err != nil {
		return 0, err
	}

	return docID, nil
}

// AppendRAGChunks adds more chunks to an already-created document.
// Used for multi-batch uploads of large documents.
func AppendRAGChunks(docID int64, chunks []RAGChunk) error {
	tx, err := DB.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	for _, chunk := range chunks {
		embeddingJSON, err := json.Marshal(chunk.Embedding)
		if err != nil {
			return fmt.Errorf("failed to marshal embedding: %w", err)
		}
		_, err = tx.Exec(`
			INSERT INTO rag_chunks (document_id, chunk_index, content, embedding)
			VALUES (?, ?, ?, ?)`,
			docID, chunk.ChunkIndex, chunk.Content, string(embeddingJSON))
		if err != nil {
			return err
		}
	}

	return tx.Commit()
}

func GetRAGDocuments() ([]RAGDocument, error) {
	// Pull the first ~200 chars of chunk 0 per document as a probe phrase for the TEST button.
	rows, err := DB.Query(`
		SELECT d.id, d.name, d.embedding_model,
		       (SELECT COUNT(*) FROM rag_chunks WHERE document_id = d.id) AS chunk_count,
		       datetime(d.created_at, 'localtime'),
		       SUBSTR(COALESCE(
		           (SELECT content FROM rag_chunks WHERE document_id = d.id ORDER BY chunk_index LIMIT 1),
		           ''
		       ), 1, 200) AS probe_phrase
		FROM rag_documents d
		ORDER BY d.id DESC
	`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var list []RAGDocument
	for rows.Next() {
		var doc RAGDocument
		if err := rows.Scan(&doc.ID, &doc.Name, &doc.EmbeddingModel, &doc.ChunkCount, &doc.CreatedAt, &doc.ProbePhrase); err != nil {
			return nil, err
		}
		list = append(list, doc)
	}
	return list, nil
}

func DeleteRAGDocument(id int64) error {
	_, err := DB.Exec("DELETE FROM rag_chunks WHERE document_id = ?", id)
	if err != nil {
		return err
	}
	_, err = DB.Exec("DELETE FROM rag_documents WHERE id = ?", id)
	return err
}

func GetRAGChunksForModel(embeddingModel string) ([]RAGChunkWithDocInfo, error) {
	rows, err := DB.Query(`
		SELECT c.id, c.document_id, d.name, c.chunk_index, c.content, c.embedding 
		FROM rag_chunks c 
		JOIN rag_documents d ON c.document_id = d.id 
		WHERE d.embedding_model = ?`, embeddingModel)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var list []RAGChunkWithDocInfo
	for rows.Next() {
		var c RAGChunkWithDocInfo
		var embedStr string
		if err := rows.Scan(&c.ChunkID, &c.DocumentID, &c.DocumentName, &c.ChunkIndex, &c.Content, &embedStr); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(embedStr), &c.Embedding); err != nil {
			return nil, fmt.Errorf("failed to unmarshal embedding: %w", err)
		}
		list = append(list, c)
	}
	return list, nil
}
