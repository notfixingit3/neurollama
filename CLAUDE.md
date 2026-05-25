# NEUROLLAMA — Agent Context

## What this is
A self-hosted Go web app for managing local and remote Ollama nodes. Nord-themed dashboard with chat playground, model builder, VRAM telemetry, benchmarks, and diagnostics. Single binary deployment.

## Tech stack
- **Backend**: Go 1.26.3 + Gin (`main.go`, `db.go`, `db_sqlite.go`, `ollama.go`)
- **Database**: SQLite via `modernc.org/sqlite` (CGO-free)
- **Frontend**: Server-rendered Go templates (`templates/index.html`) + vanilla JS (`static/js/app.js`)
- **CSS**: Tailwind CSS v4 + DaisyUI v5 (Nord theme), compiled to `static/css/output.css`

## CSS build — no Node.js
The project uses the **Tailwind v4 standalone CLI binary** (`./tailwindcss`). There is no `package.json`, no `npm`, no `node_modules`.

```bash
# Rebuild CSS after changing tailwind/input.css or templates
./tailwindcss -i tailwind/input.css -o static/css/output.css --minify

# Watch mode
./tailwindcss -i tailwind/input.css -o static/css/output.css --watch
```

The `tailwindcss` binary is gitignored (81MB). Download once:
```bash
curl -sL https://github.com/tailwindlabs/tailwindcss/releases/download/v4.3.0/tailwindcss-macos-arm64 -o tailwindcss && chmod +x tailwindcss
```

DaisyUI v5 CSS is vendored locally in `tailwind/lib/` (committed to the repo).

## Key files
| File | Purpose |
|---|---|
| `main.go` | HTTP server, routes, SSE streaming handlers |
| `ollama.go` | Ollama API client (model ops, chat, pull, VRAM) |
| `db.go` / `db_sqlite.go` | SQLite schema, migrations, server/preset/RAG CRUD |
| `templates/index.html` | Single-page template (all tabs/panels) |
| `static/js/app.js` | All frontend logic (vanilla JS, no framework) |
| `tailwind/input.css` | CSS entry point (Tailwind v4 + DaisyUI imports + custom styles) |
| `tailwind/lib/daisyui.css` | Vendored DaisyUI v5 component styles |
| `tailwind/lib/themes.css` | Vendored DaisyUI v5 themes (includes Nord) |

## Running locally
```bash
go run .           # dev
go build -o neurollama . && ./neurollama   # prod-like
```
Runs on `http://localhost:8080`. Data stored in `data/neurollama.db`.

## DaisyUI v5 notes
- Uses `data-theme="nord"` on `<html>` — do not add a theme switcher without importing additional theme CSS
- `-bordered` input variants removed in v5 — explicit `border-[#4c566a]` Tailwind classes handle borders instead
- `tabs-boxed` → `tabs-box`, `table-compact` → `table-xs`

## Commit message convention
Every commit message must end with a random Scooby-Doo quote. Examples:
- `"Scooby-Dooby-Doo!"`
- `"Ruh-roh!"`
- `"Would you do it for a Scooby Snack?"`
- `"Zoinks!"`
- `"Jeepers!"`
- `"Let's split up, gang."`
- `"I'm not a coward, I'm just... cautious."`

## Docker
Pre-built CSS is committed so the Dockerfile has zero Node/npm steps. The builder stage compiles the Go binary; the runtime stage is plain Alpine.
