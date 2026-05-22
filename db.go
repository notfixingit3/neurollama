package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

type Server struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	URL      string `json:"url"`
	IsActive bool   `json:"isActive"`
}

type Config struct {
	Servers []Server `json:"servers"`
}

var (
	configPath = filepath.Join("data", "servers.json")
	servers    []Server
	mu         sync.Mutex
)

// Generate a simple unique ID
func generateID() string {
	bytes := make([]byte, 8)
	if _, err := rand.Read(bytes); err != nil {
		// fallback to basic timestamp-based string if random fails
		return fmt.Sprintf("srv_%d", os.Getpid())
	}
	return hex.EncodeToString(bytes)
}

// LoadConfig loads the servers list from data/servers.json
func LoadConfig() error {
	mu.Lock()
	defer mu.Unlock()

	// Ensure data directory exists
	dir := filepath.Dir(configPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create data directory: %w", err)
	}

	// Check if config file exists
	if _, err := os.Stat(configPath); os.IsNotExist(err) {
		// Create default config with local Ollama
		servers = []Server{
			{
				ID:       generateID(),
				Name:     "Local Ollama",
				URL:      "http://localhost:11434",
				IsActive: true,
			},
		}
		mu.Unlock() // Temporarily unlock to call SaveConfig
		err = SaveConfigInternal()
		mu.Lock() // Re-lock for defer Unlock
		return err
	}

	// Read and parse file
	data, err := os.ReadFile(configPath)
	if err != nil {
		return fmt.Errorf("failed to read config file: %w", err)
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return fmt.Errorf("failed to parse config file: %w", err)
	}

	servers = cfg.Servers

	// Ensure at least one server is active if list is not empty
	if len(servers) > 0 {
		hasActive := false
		for _, s := range servers {
			if s.IsActive {
				hasActive = true
				break
			}
		}
		if !hasActive {
			servers[0].IsActive = true
			mu.Unlock()
			err = SaveConfigInternal()
			mu.Lock()
		}
	}

	return nil
}

// SaveConfigInternal saves the current servers slice to disk (expects lock to be held or managed)
func SaveConfigInternal() error {
	cfg := Config{Servers: servers}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	if err := os.WriteFile(configPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write config file: %w", err)
	}
	return nil
}

// SaveConfig exports the saving function with locking
func SaveConfig() error {
	mu.Lock()
	defer mu.Unlock()
	return SaveConfigInternal()
}

// GetServers returns a copy of the servers list
func GetServers() []Server {
	mu.Lock()
	defer mu.Unlock()
	res := make([]Server, len(servers))
	copy(res, servers)
	return res
}

// GetActiveServer returns the currently active Ollama server config
func GetActiveServer() (Server, error) {
	mu.Lock()
	defer mu.Unlock()

	for _, s := range servers {
		if s.IsActive {
			return s, nil
		}
	}

	if len(servers) > 0 {
		// Fallback to first server
		servers[0].IsActive = true
		cfg := Config{Servers: servers}
		data, _ := json.MarshalIndent(cfg, "", "  ")
		_ = os.WriteFile(configPath, data, 0644)
		return servers[0], nil
	}

	return Server{}, fmt.Errorf("no servers configured")
}

// AddServer adds a new server and returns it
func AddServer(name, url string) (Server, error) {
	mu.Lock()
	defer mu.Unlock()

	// Clean trailing slash from URL if present
	if len(url) > 0 && url[len(url)-1] == '/' {
		url = url[:len(url)-1]
	}

	newServer := Server{
		ID:       generateID(),
		Name:     name,
		URL:      url,
		IsActive: len(servers) == 0, // make active if it's the first server
	}

	servers = append(servers, newServer)
	if err := SaveConfigInternal(); err != nil {
		return Server{}, err
	}

	return newServer, nil
}

// EditServer updates an existing server's details
func EditServer(id, name, url string) (Server, error) {
	mu.Lock()
	defer mu.Unlock()

	// Clean trailing slash from URL if present
	if len(url) > 0 && url[len(url)-1] == '/' {
		url = url[:len(url)-1]
	}

	for i, s := range servers {
		if s.ID == id {
			servers[i].Name = name
			servers[i].URL = url
			if err := SaveConfigInternal(); err != nil {
				return Server{}, err
			}
			return servers[i], nil
		}
	}

	return Server{}, fmt.Errorf("server not found")
}

// DeleteServer removes a server by ID
func DeleteServer(id string) error {
	mu.Lock()
	defer mu.Unlock()

	index := -1
	for i, s := range servers {
		if s.ID == id {
			index = i
			break
		}
	}

	if index == -1 {
		return fmt.Errorf("server not found")
	}

	wasActive := servers[index].IsActive
	servers = append(servers[:index], servers[index+1:]...)

	// If the deleted server was active, make another one active
	if wasActive && len(servers) > 0 {
		servers[0].IsActive = true
	}

	return SaveConfigInternal()
}

// SetActiveServer selects a server to be the active one
func SetActiveServer(id string) (Server, error) {
	mu.Lock()
	defer mu.Unlock()

	found := false
	var activeServer Server
	for i, s := range servers {
		if s.ID == id {
			servers[i].IsActive = true
			activeServer = servers[i]
			found = true
		} else {
			servers[i].IsActive = false
		}
	}

	if !found {
		return Server{}, fmt.Errorf("server not found")
	}

	if err := SaveConfigInternal(); err != nil {
		return Server{}, err
	}

	return activeServer, nil
}
