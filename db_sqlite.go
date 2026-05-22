package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"

	_ "github.com/glebarez/go-sqlite"
)

var DB *sql.DB

type Chat struct {
	ID               int64    `json:"id"`
	Title            string   `json:"title"`
	Model            string   `json:"model"`
	SystemPrompt     string   `json:"system_prompt"`
	Temperature      float64  `json:"temperature"`
	NumCtx           int      `json:"num_ctx"`
	TopK             int      `json:"top_k"`
	TopP             float64  `json:"top_p"`
	RepeatPenalty    float64  `json:"repeat_penalty"`
	Seed             *int     `json:"seed"`
	MinP             float64  `json:"min_p"`
	PresencePenalty  float64  `json:"presence_penalty"`
	FrequencyPenalty float64  `json:"frequency_penalty"`
	NumPredict       int      `json:"num_predict"`
	NumGPU           int      `json:"num_gpu"`
	NumThread        int      `json:"num_thread"`
	CreatedAt        string   `json:"created_at"`
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
	TtftMs         float64 `json:"ttft_ms"`
	Tps            float64 `json:"tps"`
	AvgLatencyMs   float64 `json:"avg_latency_ms"`
	ReasoningScore string  `json:"reasoning_score"`
	Notes          string  `json:"notes"`
	CreatedAt      string  `json:"created_at"`
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

// InitDB initializes the SQLite database connection and runs migrations
func InitDB(dbPath string) error {
	// Create directory if it doesn't exist
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
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
	defer rows.Close()

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
	defer tx.Rollback()

	stmt, err := tx.Prepare("INSERT INTO presets (name, content) VALUES (?, ?)")
	if err != nil {
		return err
	}
	defer stmt.Close()

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
	defer rows.Close()

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
	defer tx.Rollback()

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
	defer rows.Close()

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
	defer rows.Close()

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
	defer rows.Close()

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
	defer rows.Close()

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
	rows, err := DB.Query("SELECT id, model_name, ttft_ms, tps, avg_latency_ms, reasoning_score, COALESCE(notes, ''), datetime(created_at, 'localtime') FROM benchmarks ORDER BY id DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []Benchmark
	for rows.Next() {
		var b Benchmark
		if err := rows.Scan(&b.ID, &b.ModelName, &b.TtftMs, &b.Tps, &b.AvgLatencyMs, &b.ReasoningScore, &b.Notes, &b.CreatedAt); err != nil {
			return nil, err
		}
		list = append(list, b)
	}
	return list, nil
}

func SaveBenchmark(modelName string, ttft, tps, avgLatency float64) (int64, error) {
	res, err := DB.Exec("INSERT INTO benchmarks (model_name, ttft_ms, tps, avg_latency_ms) VALUES (?, ?, ?, ?)", modelName, ttft, tps, avgLatency)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
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
	defer rows.Close()

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


