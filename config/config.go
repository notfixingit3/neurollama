package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// OllamaServer represents a configured Ollama server.
type OllamaServer struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	BaseURL string `json:"baseURL"`
}

type config struct {
	LastUsedServerID string         `json:"lastUsedServerID"`
	Servers          []OllamaServer `json:"servers"`
}

var (
	mu sync.RWMutex

	servers          []OllamaServer
	lastUsedServerID string
)

func getConfigPath() string {
	dir, _ := os.UserConfigDir()
	return filepath.Join(dir, "ollama-manager", "config.json")
}

func Load() {
	mu.Lock()
	defer mu.Unlock()

	loadLocked()
}

func loadLocked() {
	data, err := os.ReadFile(getConfigPath())
	if err != nil {
		legacy := filepath.Join(filepath.Dir(getConfigPath()), "servers.json")
		data, err = os.ReadFile(legacy)
		if err != nil {
			return
		}
	}

	var cfg config
	if json.Unmarshal(data, &cfg) == nil && cfg.Servers != nil {
		servers          = cfg.Servers
		lastUsedServerID = cfg.LastUsedServerID
		return
	}

	json.Unmarshal(data, &servers)
}

// Save writes the current config to disk.
func Save() {
	mu.Lock()
	defer mu.Unlock()

	saveLocked()
}

func saveLocked() {
	path := getConfigPath()
	os.MkdirAll(filepath.Dir(path), 0755)

	cfg := config{
		LastUsedServerID: lastUsedServerID,
		Servers:          servers,
	}
	data, _ := json.MarshalIndent(cfg, "", "  ")
	os.WriteFile(path, data, 0644)
}

// GetServers returns a copy of the current server list.
func GetServers() []OllamaServer {
	mu.RLock()
	defer mu.RUnlock()

	out := make([]OllamaServer, len(servers))
	copy(out, servers)
	return out
}

// GetCurrentServer returns the currently selected server, or nil.
func GetCurrentServer() *OllamaServer {
	mu.RLock()
	defer mu.RUnlock()

	for i := range servers {
		if servers[i].ID == lastUsedServerID {
			srv := servers[i]
			return &srv
		}
	}
	return nil
}

// SetCurrentServer sets the active server by ID and persists the change.
func SetCurrentServer(id string) {
	mu.Lock()
	defer mu.Unlock()

	lastUsedServerID = id
	saveLocked()
}

// SetServers replaces the entire server list and persists.
func SetServers(s []OllamaServer) {
	mu.Lock()
	defer mu.Unlock()

	servers = make([]OllamaServer, len(s))
	copy(servers, s)
	saveLocked()
}
