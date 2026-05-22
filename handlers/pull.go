package handlers

import (
	"bufio"
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"ollama-manager/config"
	"ollama-manager/ollama"
)

// PullProgress represents a single progress update for SSE streaming.
type PullProgress struct {
	Status    string `json:"status"`
	Completed int64  `json:"completed"`
	Total     int64  `json:"total"`
}

// PullStatusResponse is returned by POST /models/pull to render the progress partial.
type PullStatusResponse struct {
	Name string
}

// RegisterPullRoutes registers the pull-related routes.
func RegisterPullRoutes(r *gin.Engine, tmpl *template.Template) {
	r.POST("/models/pull", func(c *gin.Context) {
		name := strings.TrimSpace(c.PostForm("name"))
		if name == "" {
			c.String(http.StatusBadRequest, "model name is required")
			return
		}

		srv := config.GetCurrentServer()
		if srv == nil {
			c.String(http.StatusBadRequest, "no server selected")
			return
		}

		// Return the progress partial so HTMX can connect to the SSE endpoint.
		data := PullStatusResponse{Name: name}
		if err := tmpl.ExecuteTemplate(c.Writer, "pull_progress", data); err != nil {
			c.String(http.StatusInternalServerError, err.Error())
		}
	})

	r.GET("/events/pull/:name", func(c *gin.Context) {
		name := strings.TrimSpace(c.Param("name"))
		if name == "" {
			c.String(http.StatusBadRequest, "model name is required")
			return
		}

		srv := config.GetCurrentServer()
		if srv == nil {
			c.String(http.StatusBadRequest, "no server selected")
			return
		}

		// Open the streaming pull connection.
		stream, err := ollama.PullModelStream(srv.BaseURL, name)
		if err != nil {
			c.String(http.StatusInternalServerError, err.Error())
			return
		}
		defer stream.Close()

		// Set SSE headers.
		c.Header("Content-Type", "text/event-stream")
		c.Header("Cache-Control", "no-cache")
		c.Header("Connection", "keep-alive")
		c.Header("X-Accel-Buffering", "no")
		c.Status(http.StatusOK)

		// Stream JSON lines from Ollama as SSE events.
		c.Stream(func(w io.Writer) bool {
			scanner := bufio.NewScanner(stream)
			for scanner.Scan() {
				line := scanner.Text()
				if line == "" {
					continue
				}

				var progress PullProgress
				if err := json.Unmarshal([]byte(line), &progress); err != nil {
					// Send error event for unparseable lines.
					fmt.Fprintf(w, "event: error\ndata: %s\n\n", jsonEscape(fmt.Sprintf(`{"error":"%s"}`, err.Error())))
					continue
				}

				// Compute percent if total > 0.
				percent := 0
				if progress.Total > 0 {
					percent = int(float64(progress.Completed) / float64(progress.Total) * 100)
				}

				payload, _ := json.Marshal(map[string]any{
					"status":  progress.Status,
					"percent": percent,
				})
				fmt.Fprintf(w, "event: progress\ndata: %s\n\n", payload)
			}

			if err := scanner.Err(); err != nil {
				fmt.Fprintf(w, "event: error\ndata: %s\n\n", jsonEscape(fmt.Sprintf(`{"error":"%s"}`, err.Error())))
				return false
			}

			// Signal completion.
			fmt.Fprint(w, "event: complete\ndata: done\n\n")
			return false
		})
	})
}

// jsonEscape returns a JSON-string-encoded version of s suitable for SSE data lines.
func jsonEscape(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
