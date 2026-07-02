package main

import (
	"crypto/tls"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const defaultPort = 11435

var agentVersion = "v0.1.1"

var apiKey string

func main() {
	port := flag.Int("port", defaultPort, "Port to listen on")
	flag.Parse()

	dir := configDir()
	if err := os.MkdirAll(dir, 0700); err != nil {
		log.Fatalf("config dir: %v", err)
	}

	// API key: env override or load/generate from disk
	apiKey = os.Getenv("NEURO_AGENT_KEY")
	if apiKey == "" {
		apiKey = loadOrGenerate(filepath.Join(dir, "api.key"), func() string {
			b := make([]byte, 32)
			rand.Read(b)
			return hex.EncodeToString(b)
		})
	}

	certFile := filepath.Join(dir, "cert.pem")
	keyFile  := filepath.Join(dir, "key.pem")
	fp := ensureCert(certFile, keyFile)

	// Write info.json so automated deploy can read key + fingerprint back
	type agentInfo struct {
		APIKey      string `json:"api_key"`
		Fingerprint string `json:"fingerprint"`
		Port        int    `json:"port"`
	}
	if infoData, err := json.Marshal(agentInfo{APIKey: apiKey, Fingerprint: fp, Port: *port}); err == nil {
		os.WriteFile(filepath.Join(dir, "info.json"), infoData, 0600)
	}

	fmt.Printf("neuro-agent %s\n", agentVersion)
	fmt.Printf("Listening:       https://0.0.0.0:%d\n", *port)
	fmt.Printf("API Key:         %s\n", apiKey)
	fmt.Printf("TLS Fingerprint: %s\n", fp)
	fmt.Printf("\nPaste both values into the node settings in NEUROLLAMA.\n")

	mux := http.NewServeMux()
	mux.HandleFunc("/health",  healthHandler)
	mux.HandleFunc("/metrics", requireBearer(metricsHandler))

	srv := &http.Server{
		Addr:    fmt.Sprintf(":%d", *port),
		Handler: mux,
		TLSConfig: &tls.Config{
			MinVersion: tls.VersionTLS13,
		},
	}

	log.Fatal(srv.ListenAndServeTLS(certFile, keyFile))
}

func healthHandler(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok", "version": agentVersion})
}

func metricsHandler(w http.ResponseWriter, _ *http.Request) {
	m, err := collectMetrics()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(m)
}

func requireBearer(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		token := strings.TrimPrefix(auth, "Bearer ")
		if token == "" || token == auth || token != apiKey {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

func loadOrGenerate(path string, gen func() string) string {
	if data, err := os.ReadFile(path); err == nil {
		if s := strings.TrimSpace(string(data)); s != "" {
			return s
		}
	}
	val := gen()
	os.WriteFile(path, []byte(val+"\n"), 0600)
	return val
}

func configDir() string {
	if d := os.Getenv("NEURO_AGENT_CONFIG"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "neuro-agent")
}
