# AGENTS.md — ollama-manager

Web-based Ollama server and model manager built with Go, Gin, DaisyUI (Nord theme), and HTMX.

## Project

- **Language**: Go 1.26.3
- **Web framework**: [Gin](https://gin-gonic.com/) v1.12.0 (`github.com/gin-gonic/gin`)
- **Frontend**: Server-rendered HTML with [HTMX](https://htmx.org/) for interactivity
- **Styling**: [DaisyUI](https://daisyui.com/) v5 with [Nord](https://www.nordtheme.com/) theme via Tailwind CSS v4
- **Entrypoint**: `main.go` (Gin router setup, embed directives)
- **Binary**: `ollama-manager` (built artifact, committed to repo)

## Build & Run

```bash
# Build CSS first (requires Node.js)
cd tailwind && npm install && npx tailwindcss -i input.css -o ../static/css/output.css

# Build the macOS binary
go build -o ollama-manager

# Run directly
./ollama-manager
```

- Server starts on port 8080 (configurable via `PORT` env var)
- No tests, no Makefile, no lint config
- The compiled binary `ollama-manager` is checked into git — rebuild and commit when changing code

## Architecture

- **Multi-file project**: `handlers/`, `ollama/`, `config/`, `templates/`, `static/`, `utils/`
- **Server-rendered UI**: Go `html/template` with embedded templates (`//go:embed`)
- **HTMX interactivity**: `hx-get`, `hx-post`, `hx-delete` for model list, detail expansion, pull, delete
- **SSE streaming**: Live pull progress via `events/pull/:name` endpoint with HTMX SSE extension
- **Ollama API client**: Talks to configurable Ollama servers via HTTP (`/api/tags`, `/api/show`, `/api/pull`, `/api/delete`, `/api/version`)
- **Config**: JSON stored at `~/Library/Application Support/ollama-manager/config.json` (macOS). Legacy fallback to `servers.json` in same dir.

## Key Conventions

- **DaisyUI Nord theme**: `data-theme="nord"` on `<html>`, colors mapped to Nord palette
- **HTMX patterns**: All form submissions and navigation use HTMX attributes; no page reloads for common actions
- **Model detail expansion**: Clicking a row fetches `/models/{name}/detail` and swaps in a detail partial
- **Server management**: Dropdown-based CRUD for servers; currently selected server persisted as `lastUsedServerID`
- **Static asset embedding**: CSS, JS, and templates embedded in binary via `embed.FS` — no external files needed at runtime

## Dependencies

- `go.mod` has one direct dependency: `github.com/gin-gonic/gin v1.12.0`
- All others are indirect (render, validator, json, yaml, etc.)
- Node.js only needed at build time for Tailwind CSS compilation

## Notes for Agents

- This is a **multi-file codebase** with packages: `config/`, `ollama/`, `handlers/`, `utils/`
- When modifying UI, use DaisyUI component classes (e.g., `btn`, `card`, `table`, `navbar`)
- The app expects an Ollama server running at the configured `BaseURL` (default `http://localhost:11434`)
- No external build tools beyond `go build` and `npx tailwindcss`

## Commit Messages

- Always append a random Scooby-Doo quote at the end of every commit message (e.g., "Ruh-roh!", "Zoinks!", "Jinkies!", "Would you do it for a Scooby Snack?").
