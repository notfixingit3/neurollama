# AGENTS.md — ollama-manager

Single-file Go GUI app for managing Ollama servers and models.

## Project

- **Language**: Go 1.26.3
- **GUI framework**: [Fyne](https://fyne.io/) v2.7.4 (`fyne.io/fyne/v2`)
- **Entrypoint**: `main.go` (single file, ~875 lines)
- **Binary**: `ollama-manager` (built artifact, committed to repo)

## Build & Run

```bash
# Build the macOS binary
go build -o ollama-manager

# Run directly
go run main.go
```

- No tests, no CI, no Makefile, no lint config.
- The compiled binary `ollama-manager` is checked into git — rebuild and commit when changing code.

## Architecture

- **Single-file app**: All UI, API, config, and formatting logic lives in `main.go`.
- **Fyne GUI**: Custom dark theme (`appTheme`) with hardcoded SF font paths from `/System/Library/Fonts/`.
- **Ollama API client**: Talks to configurable Ollama servers via HTTP (`/api/tags`, `/api/show`, `/api/pull`, `/api/delete`, `/api/version`).
- **Config**: JSON stored at `~/Library/Application Support/ollama-manager/config.json` (macOS). Legacy fallback to `servers.json` in same dir.

## Key Conventions

- **macOS-only font loading**: `init()` tries to load San Francisco fonts from `/System/Library/Fonts/SFNS.ttf` etc. Falls back to Fyne defaults if missing.
- **Threading**: All HTTP calls run in goroutines; UI updates must be wrapped in `fyne.Do(...)`.
- **Model detail expansion**: Tapping a row’s chevron fetches `/api/show` in a goroutine and replaces an inline progress bar with a 2-column grid of metadata.
- **Server management**: Dialog-based CRUD for servers; the currently selected server is persisted as `lastUsedServerID`.

## Dependencies

- `go.mod` has one direct dependency: `fyne.io/fyne/v2 v2.7.4`
- All others are indirect (systray, glfw, gl, image handling, etc.)

## Notes for Agents

- This is a **single-file codebase** — there are no packages, no tests, no subdirectories with Go code.
- When modifying UI, remember Fyne’s container/layout APIs (e.g., `container.NewBorder`, `container.NewVBox`).
- The app expects an Ollama server running at the configured `BaseURL` (default `http://localhost:11434`).
- No external build tools or task runners; `go build` is the entire toolchain.
