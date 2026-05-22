package handlers

import (
	"fmt"
	"html/template"
	"net/http"
	"strings"

	"ollama-manager/config"
	"ollama-manager/ollama"
	"ollama-manager/utils"
)

func DeleteModelHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	server := config.GetCurrentServer()
	if server == nil {
		http.Error(w, "No server selected", http.StatusBadRequest)
		return
	}

	name := strings.TrimPrefix(r.URL.Path, "/models/")
	if name == "" {
		http.Error(w, "Model name required", http.StatusBadRequest)
		return
	}

	ollama.DeleteModel(server.BaseURL, name)
	w.WriteHeader(http.StatusOK)
}

// BulkDeleteModelsHandler handles POST /models/delete.
// It accepts names[] form values, deletes each model, and returns the updated model list partial.
func BulkDeleteModelsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	server := config.GetCurrentServer()
	if server == nil {
		http.Error(w, "No server selected", http.StatusBadRequest)
		return
	}

	if err := r.ParseForm(); err != nil {
		http.Error(w, "Invalid form data", http.StatusBadRequest)
		return
	}

	names := r.Form["names[]"]
	for _, name := range names {
		if name != "" {
			ollama.DeleteModel(server.BaseURL, name)
		}
	}

	models := ollama.FetchModels(server.BaseURL)

	// Parse the model list partial template
	tmpl, err := template.ParseFiles("templates/partials/model_list.html")
	if err != nil {
		http.Error(w, "Template error", http.StatusInternalServerError)
		return
	}

	data := struct {
		Models []ollama.OllamaModel
		Server *config.OllamaServer
	}{
		Models: models,
		Server: server,
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := tmpl.ExecuteTemplate(w, "model_list", data); err != nil {
		http.Error(w, "Render error", http.StatusInternalServerError)
		return
	}
}

func RegisterModels(mux *http.ServeMux, tmpl *template.Template) {
	mux.HandleFunc("GET /models", func(w http.ResponseWriter, r *http.Request) {
		srv := config.GetCurrentServer()
		if srv == nil {
			http.Error(w, "No server selected", http.StatusBadRequest)
			return
		}

		models := ollama.FetchModels(srv.BaseURL)
		data := struct {
			Models []ollama.OllamaModel
		}{
			Models: models,
		}

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		tmpl.ExecuteTemplate(w, "partial", data)
	})

	mux.HandleFunc("GET /models/{name}/detail", func(w http.ResponseWriter, r *http.Request) {
		srv := config.GetCurrentServer()
		if srv == nil {
			http.Error(w, "No server selected", http.StatusBadRequest)
			return
		}

		name := r.PathValue("name")
		info, err := ollama.FetchModelInfo(srv.BaseURL, name)

		type kv struct {
			Key string
			Val string
		}
		var kvs []kv
		add := func(key, val string) {
			if val == "" {
				return
			}
			kvs = append(kvs, kv{Key: key, Val: val})
		}

		if err == nil && info != nil {
			add("Format", strings.ToUpper(info.Details.Format))
			add("Family", info.Details.Family)
			add("Parameter size", info.Details.ParameterSize)
			add("Quantization", info.Details.QuantizationLevel)
			if info.Details.ParentModel != "" {
				add("Based on", info.Details.ParentModel)
			}

			arch, _ := info.ModelInfo["general.architecture"].(string)
			if arch != "" {
				pfx := arch + "."
				getF := func(key string) (float64, bool) {
					v, ok := info.ModelInfo[pfx+key]
					if !ok {
						return 0, false
					}
					n, ok := v.(float64)
					return n, ok
				}
				if n, ok := getF("context_length"); ok {
					add("Context window", format.Ctx(int64(n)))
				}
				if n, ok := getF("embedding_length"); ok {
					add("Embedding dim", fmt.Sprintf("%d", int64(n)))
				}
				if n, ok := getF("block_count"); ok {
					add("Layers", fmt.Sprintf("%d", int64(n)))
				}
				if n, ok := getF("attention.head_count"); ok {
					add("Attn heads", fmt.Sprintf("%d", int64(n)))
				}
				if n, ok := getF("attention.head_count_kv"); ok {
					add("KV heads", fmt.Sprintf("%d", int64(n)))
				}
			}
			if v, ok := info.ModelInfo["general.parameter_count"].(float64); ok && v > 0 {
				add("Parameters", format.Count(v))
			}

			if info.Parameters != "" {
				for _, line := range strings.Split(info.Parameters, "\n") {
					line = strings.TrimSpace(line)
					if line == "" {
						continue
					}
					var key, val string
					if idx := strings.IndexByte(line, '\t'); idx >= 0 {
						key = strings.TrimSpace(line[:idx])
						val = strings.Trim(strings.TrimSpace(line[idx+1:]), `"`)
					} else {
						parts := strings.SplitN(line, " ", 2)
						if len(parts) == 2 {
							key, val = parts[0], strings.TrimSpace(parts[1])
						}
					}
					switch key {
					case "temperature":
						add("Temperature", val)
					case "top_p":
						add("Top-p", val)
					case "top_k":
						add("Top-k", val)
					case "num_ctx":
						add("Num context", val)
					}
				}
			}
		}

		data := struct {
			Name string
			Err  error
			KVs  []kv
		}{
			Name: name,
			Err:  err,
			KVs:  kvs,
		}

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		tmpl.ExecuteTemplate(w, "partial", data)
	})
}
