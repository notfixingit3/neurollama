package main

import (
	"embed"
	"html/template"
	"io/fs"
	"log"
	"net/http"
	"os"

	"github.com/gin-gonic/gin"

	"ollama-manager/config"
	"ollama-manager/handlers"
)

//go:embed templates/layout/*.html templates/partials/*.html
var templateFS embed.FS

//go:embed static/*
var staticFS embed.FS

func main() {
	config.Load()

	tmpl := template.Must(template.ParseFS(templateFS,
		"templates/layout/*.html",
		"templates/partials/*.html",
	))

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Logger(), gin.Recovery())
	r.SetHTMLTemplate(tmpl)

	handlers.RegisterPullRoutes(r, tmpl)

	subMux := http.NewServeMux()
	handlers.RegisterModels(subMux, tmpl)
	subMux.HandleFunc("DELETE /models/{name}", handlers.DeleteModelHandler)
	subMux.HandleFunc("POST /models/delete", handlers.BulkDeleteModelsHandler)

	sh := &handlers.ServersHandler{Templates: tmpl}
	sh.RegisterRoutes(subMux)

	r.Any("/models", gin.WrapH(subMux))
	r.Any("/models/*any", gin.WrapH(subMux))
	r.Any("/servers", gin.WrapH(subMux))
	r.Any("/servers/*any", gin.WrapH(subMux))

	staticRoot, err := fs.Sub(staticFS, "static")
	if err != nil {
		log.Fatalf("static sub-fs: %v", err)
	}
	r.StaticFS("/static", http.FS(staticRoot))

	r.GET("/", func(c *gin.Context) {
		servers := config.GetServers()
		current := config.GetCurrentServer()

		data := gin.H{
			"servers": servers,
		}
		if current != nil {
			data["currentServerID"]   = current.ID
			data["currentServerName"] = current.Name
			data["currentServerURL"]  = current.BaseURL
		}

		c.HTML(http.StatusOK, "base.html", data)
	})

	log.Printf("Ollama Manager listening on :%s", port)
	if err := r.Run(":" + port); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
