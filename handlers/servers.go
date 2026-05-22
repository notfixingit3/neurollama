package handlers

import (
	"html/template"
	"net/http"
	"strconv"
	"strings"
	"time"

	"ollama-manager/config"
)

type ServerListItem struct {
	ID         string
	Name       string
	BaseURL    string
	IsCurrent  bool
}

type ServersHandler struct {
	Templates *template.Template
}

func (h *ServersHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /servers", h.List)
	mux.HandleFunc("POST /servers", h.Create)
	mux.HandleFunc("PUT /servers/{id}", h.Update)
	mux.HandleFunc("DELETE /servers/{id}", h.Delete)
	mux.HandleFunc("POST /servers/{id}/select", h.Select)
}

func (h *ServersHandler) List(w http.ResponseWriter, r *http.Request) {
	servers := config.GetServers()
	current := config.GetCurrentServer()
	currentID := ""
	if current != nil {
		currentID = current.ID
	}

	items := make([]ServerListItem, len(servers))
	for i, s := range servers {
		items[i] = ServerListItem{
			ID:        s.ID,
			Name:      s.Name,
			BaseURL:   s.BaseURL,
			IsCurrent: s.ID == currentID,
		}
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := h.Templates.ExecuteTemplate(w, "server-list", items); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (h *ServersHandler) Create(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad form", http.StatusBadRequest)
		return
	}

	name := strings.TrimSpace(r.FormValue("name"))
	baseURL := strings.TrimSpace(r.FormValue("baseURL"))
	if name == "" || baseURL == "" {
		http.Error(w, "name and baseURL required", http.StatusBadRequest)
		return
	}

	servers := config.GetServers()
	servers = append(servers, config.OllamaServer{
		ID:      strconv.FormatInt(time.Now().UnixNano(), 10),
		Name:    name,
		BaseURL: baseURL,
	})
	config.SetServers(servers)
	config.SetCurrentServer(servers[len(servers)-1].ID)

	h.List(w, r)
}

func (h *ServersHandler) Update(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		http.Error(w, "missing id", http.StatusBadRequest)
		return
	}

	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad form", http.StatusBadRequest)
		return
	}

	name := strings.TrimSpace(r.FormValue("name"))
	baseURL := strings.TrimSpace(r.FormValue("baseURL"))
	if name == "" || baseURL == "" {
		http.Error(w, "name and baseURL required", http.StatusBadRequest)
		return
	}

	servers := config.GetServers()
	found := false
	for i := range servers {
		if servers[i].ID == id {
			servers[i].Name = name
			servers[i].BaseURL = baseURL
			found = true
			break
		}
	}
	if !found {
		http.Error(w, "server not found", http.StatusNotFound)
		return
	}

	config.SetServers(servers)
	h.List(w, r)
}

func (h *ServersHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		http.Error(w, "missing id", http.StatusBadRequest)
		return
	}

	servers := config.GetServers()
	current := config.GetCurrentServer()
	newServers := make([]config.OllamaServer, 0, len(servers))
	for _, s := range servers {
		if s.ID != id {
			newServers = append(newServers, s)
		}
	}

	if current != nil && current.ID == id && len(newServers) > 0 {
		config.SetCurrentServer(newServers[0].ID)
	} else if current != nil && current.ID == id {
		config.SetCurrentServer("")
	}

	config.SetServers(newServers)
	h.List(w, r)
}

func (h *ServersHandler) Select(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		http.Error(w, "missing id", http.StatusBadRequest)
		return
	}

	config.SetCurrentServer(id)
	h.List(w, r)
}
