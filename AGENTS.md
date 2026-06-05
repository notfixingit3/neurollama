# PROJECT KNOWLEDGE BASE

**Generated:** 2026-06-04
**Commit:** HEAD
**Branch:** dev

## OVERVIEW
Self-hosted Go web app for managing local & remote Ollama nodes. Nord-themed dashboard with chat playground, model builder + NeuroWizard (13 guided wizards), VRAM telemetry, benchmarks (8 types), RAG with collection manager, SSH-based remote Ollama update, activity log, and diagnostics. Single binary deployment.

## STRUCTURE
```
.
├── main.go              # HTTP server, routes, SSE streaming
├── ollama.go            # Ollama API client (model ops, chat, pull, VRAM)
├── db.go / db_sqlite.go # SQLite schema, migrations, CRUD
├── templates/
│   └── index.html       # Single-page template (all tabs/panels)
├── static/
│   ├── js/app.js        # All frontend logic (vanilla JS, no framework)
│   └── css/output.css   # Pre-compiled Tailwind + DaisyUI
├── tailwind/
│   ├── input.css        # CSS entry point (Tailwind v4 + DaisyUI imports)
│   └── lib/             # Vendored DaisyUI v5 component styles & themes
├── Dockerfile           # Multi-stage build (Go builder → Alpine runtime)
├── docker-compose.yml   # Compose service definition
└── .github/workflows/   # CI/CD release workflow
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Add/modify API routes | `main.go` | Gin routes + SSE streaming handlers |
| Ollama API integration | `ollama.go` | Model ops, chat, pull, VRAM telemetry |
| Database schema/migrations | `db.go`, `db_sqlite.go` | SQLite via `modernc.org/sqlite` (CGO-free) |
| UI layout changes | `templates/index.html` | Single-page template with all tabs/panels |
| Frontend logic | `static/js/app.js` | Vanilla JS, no framework |
| CSS/styling | `tailwind/input.css` | Tailwind v4 + DaisyUI imports |
| DaisyUI components | `tailwind/lib/daisyui.css` | Vendored DaisyUI v5 styles |
| Themes | `tailwind/lib/themes.css` | Vendored DaisyUI v5 themes (includes Nord) |
| Docker build | `Dockerfile` | Multi-stage: golang:1.26.3-alpine → alpine:latest |
| CI/CD release | `.github/workflows/release.yml` | Tag-triggered release with auto-generated notes |

## CONVENTIONS
- **Go version**: 1.26.3
- **Frontend**: Vanilla JS only — no React, Vue, etc.
- **CSS build**: Tailwind v4 standalone CLI binary (`./tailwindcss`) — no Node.js/npm locally
- **DaisyUI v5 specific**:
  - Theme: `data-theme="nord"` on `<html>`
  - No `-bordered` input variants → use explicit `border-[#4c566a]` classes
  - `tabs-boxed` → `tabs-box`
  - `table-compact` → `table-xs`
- **Commit messages**: Must end with a random Scooby-Doo quote (e.g., `"Zoinks!"`, `"Ruh-roh!"`)

## ANTI-PATTERNS (THIS PROJECT)
- **Never** add a theme switcher without importing additional theme CSS
- **Never** use Node.js/npm for local CSS build — use the standalone Tailwind CLI binary
- **Never** commit the `tailwindcss` binary (it's gitignored, 81MB)
- **Never** use `-bordered` DaisyUI input variants (removed in v5)
- **Never** override the Modelfile `System` prompt for code/hallucination generation — it strips safety context and causes some models to refuse benign tasks. Use `Think: false` + `/no_think` prompt suffix instead for thinking models (Qwen3, QwQ, DeepSeek-R1, etc.)
- **Never** use role-description system prompts ("you are a code generation assistant") — lower-quality models interpret them literally and generate a code generator instead of code. Use constraint language ("Write only the code asked for.") in judge prompts only.

## UNIQUE STYLES
- **Low-config philosophy**: No `.eslintrc`, `.editorconfig`, or `pyproject.toml` — conventions enforced via `CLAUDE.md` and Go compiler
- **Pre-built CSS committed**: `static/css/output.css` is committed so Dockerfile has zero Node/npm steps
- **Scooby-Doo commit rule**: All commits must end with a random Scooby-Doo quote
- **Legacy DB migration**: If `data/ollama-manager.db` exists and `data/neurollama.db` does not, app renames old DB on startup

## COMMANDS
```bash
# Development
go run .

# Production build
go build -o neurollama . && ./neurollama

# Rebuild CSS (after changing tailwind/input.css or templates)
./tailwindcss -i tailwind/input.css -o static/css/output.css --minify

# Watch mode for CSS
./tailwindcss -i tailwind/input.css -o static/css/output.css --watch

# Docker
docker build -t neurollama .
docker-compose up -d
```

## NOTES
- Runs on `http://localhost:8811` by default; override with `PORT` env var
- Data stored in `data/neurollama.db` (auto-created on first launch)
- SSH key store encryption key at `data/ssh_keystore.key` (0600, auto-generated, AES-256-GCM)
- Server credentials (Bearer tokens, Basic Auth passwords) are redacted from API responses
- Remote node limitation: Ollama API doesn't expose total VRAM capacity — VRAM percentage bars not meaningful for remote servers
- CI release workflow does NOT build CSS — `static/css/output.css` is pre-compiled and committed; the CI job only compiles the Go binary
- All `innerHTML` insertions of server/user data MUST use `escapeHTML()` — audit complete as of v0.2.24
- NeuroWizard shared infrastructure: `_wzLaunch(id, modelfile, newName)` handles all SSE streaming; `launchWz(id)` is the dispatch entry point; `populateWizardSelects()` keeps model selects in sync
