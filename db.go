package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"sync"
)

type Server struct {
	ID               string  `json:"id"`
	Name             string  `json:"name"`
	URL              string  `json:"url"`
	IsActive         bool    `json:"isActive"`
	VramGB           float64 `json:"vramGb,omitempty"` // manually configured total GPU VRAM (GB)
	AuthType         string  `json:"authType,omitempty"`
	AuthToken        string  `json:"authToken,omitempty"`
	AuthUsername     string  `json:"authUsername,omitempty"`
	AuthPassword     string  `json:"authPassword,omitempty"`
	AuthHeaderName   string  `json:"authHeaderName,omitempty"`
	AuthHeaderVal    string  `json:"authHeaderVal,omitempty"`
	AgentPort        int     `json:"agentPort,omitempty"`        // neuro-agent port (default 11435)
	AgentKey         string  `json:"agentKey,omitempty"`         // Bearer token for neuro-agent
	AgentFingerprint string  `json:"agentFingerprint,omitempty"` // SHA-256 of agent TLS cert DER
}

type Config struct {
	Servers []Server `json:"servers"`
}

var (
	servers []Server
	mu      sync.Mutex
)

const (
	dataDir          = "data"
	serverConfigFile = "servers.json"
)

func openDataRoot() (*os.Root, error) {
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return nil, fmt.Errorf("failed to create data directory: %w", err)
	}

	root, err := os.OpenRoot(dataDir)
	if err != nil {
		return nil, fmt.Errorf("failed to open data directory: %w", err)
	}

	return root, nil
}

func closeDataRoot(root *os.Root, operationErr *error) {
	if closeErr := root.Close(); closeErr != nil && *operationErr == nil {
		*operationErr = fmt.Errorf("failed to close data directory: %w", closeErr)
	}
}

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
func LoadConfig() (err error) {
	mu.Lock()
	defer mu.Unlock()

	root, err := openDataRoot()
	if err != nil {
		return err
	}
	defer closeDataRoot(root, &err)

	// Check if config file exists
	if _, err = root.Stat(serverConfigFile); os.IsNotExist(err) {
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
	} else if err != nil {
		return fmt.Errorf("failed to stat config file: %w", err)
	}
	if err = root.Chmod(serverConfigFile, 0600); err != nil {
		return fmt.Errorf("failed to secure config file permissions: %w", err)
	}

	// Read and parse file
	data, err := root.ReadFile(serverConfigFile)
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
func SaveConfigInternal() (err error) {
	cfg := Config{Servers: servers}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	root, err := openDataRoot()
	if err != nil {
		return err
	}
	defer closeDataRoot(root, &err)

	if err := root.WriteFile(serverConfigFile, data, 0600); err != nil {
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
		if err := SaveConfigInternal(); err != nil {
			return Server{}, err
		}
		return servers[0], nil
	}

	return Server{}, fmt.Errorf("no servers configured")
}

func RedactServerSecrets(s Server) Server {
	s.AuthToken = ""
	s.AuthPassword = ""
	s.AuthHeaderVal = ""
	return s
}

func MergeAuthFields(existing Server, authType, authToken, authUsername, authPassword, authHeaderName, authHeaderVal string) (string, string, string, string, string, string) {
	switch authType {
	case "bearer":
		if authToken == "" && existing.AuthType == authType {
			authToken = existing.AuthToken
		}
		authUsername = ""
		authPassword = ""
		authHeaderName = ""
		authHeaderVal = ""
	case "basic":
		if authUsername == "" && existing.AuthType == authType {
			authUsername = existing.AuthUsername
		}
		if authPassword == "" && existing.AuthType == authType {
			authPassword = existing.AuthPassword
		}
		authToken = ""
		authHeaderName = ""
		authHeaderVal = ""
	case "custom":
		if authHeaderName == "" && existing.AuthType == authType {
			authHeaderName = existing.AuthHeaderName
		}
		if authHeaderVal == "" && existing.AuthType == authType {
			authHeaderVal = existing.AuthHeaderVal
		}
		authToken = ""
		authUsername = ""
		authPassword = ""
	default:
		authType = "none"
		authToken = ""
		authUsername = ""
		authPassword = ""
		authHeaderName = ""
		authHeaderVal = ""
	}

	return authType, authToken, authUsername, authPassword, authHeaderName, authHeaderVal
}

// AddServer adds a new server and returns it
func AddServer(name, url, authType, authToken, authUsername, authPassword, authHeaderName, authHeaderVal string, vramGB float64, agentPort int, agentKey, agentFingerprint string) (Server, error) {
	mu.Lock()
	defer mu.Unlock()

	// Clean trailing slash from URL if present
	if len(url) > 0 && url[len(url)-1] == '/' {
		url = url[:len(url)-1]
	}

	newServer := Server{
		ID:               generateID(),
		Name:             name,
		URL:              url,
		IsActive:         len(servers) == 0,
		VramGB:           vramGB,
		AuthType:         authType,
		AuthToken:        authToken,
		AuthUsername:     authUsername,
		AuthPassword:     authPassword,
		AuthHeaderName:   authHeaderName,
		AuthHeaderVal:    authHeaderVal,
		AgentPort:        agentPort,
		AgentKey:         agentKey,
		AgentFingerprint: agentFingerprint,
	}

	servers = append(servers, newServer)
	if err := SaveConfigInternal(); err != nil {
		return Server{}, err
	}

	return newServer, nil
}

// EditServer updates an existing server's details
func EditServer(id, name, url, authType, authToken, authUsername, authPassword, authHeaderName, authHeaderVal string, vramGB float64, agentPort int, agentKey, agentFingerprint string) (Server, error) {
	mu.Lock()
	defer mu.Unlock()

	// Clean trailing slash from URL if present
	if len(url) > 0 && url[len(url)-1] == '/' {
		url = url[:len(url)-1]
	}

	for i, s := range servers {
		if s.ID == id {
			authType, authToken, authUsername, authPassword, authHeaderName, authHeaderVal = MergeAuthFields(s, authType, authToken, authUsername, authPassword, authHeaderName, authHeaderVal)

			servers[i].Name             = name
			servers[i].URL              = url
			servers[i].VramGB           = vramGB
			servers[i].AuthType         = authType
			servers[i].AuthToken        = authToken
			servers[i].AuthUsername     = authUsername
			servers[i].AuthPassword     = authPassword
			servers[i].AuthHeaderName   = authHeaderName
			servers[i].AuthHeaderVal    = authHeaderVal
			servers[i].AgentPort        = agentPort
			servers[i].AgentKey         = agentKey
			servers[i].AgentFingerprint = agentFingerprint
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
