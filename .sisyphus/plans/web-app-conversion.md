# Convert Ollama Manager to Web App (Gin + DaisyUI Nord)

## TL;DR

> Convert the single-file Fyne desktop Ollama Manager into a server-rendered web app using Gin, DaisyUI (Nord theme), and HTMX. All 6 features preserved: server CRUD, model listing, model detail expansion, live pull progress (SSE), bulk delete, and stats display. Single binary deployment via Go embed. Fyne dependency removed entirely.
>
> **Deliverables**:
> - Multi-file Go project (handlers/, templates/, static/, ollama/)
> - DaisyUI v5 Nord-themed CSS (compiled via Tailwind v4 CLI)
> - HTMX-powered interactivity with SSE for pull progress
> - Updated GitHub Actions release workflow (Node.js + Tailwind build step)
> - New `ollama-manager` binary replacing the Fyne binary
>
> **Estimated Effort**: Large (~8-12 hours)
> **Parallel Execution**: YES — 4 waves
> **Critical Path**: Wave 1 (scaffolding) → Wave 2 (core modules) → Wave 3 (UI + integration) → Wave 4 (build + release)

---

## Context

### Original Request
"Convert this app to web app using Gin and daisyui with nord theme"

### Interview Summary
**Key Discussions**:
- **Frontend approach**: Server-rendered HTML (Go html/template) + DaisyUI + Tailwind CSS v4 + HTMX (user chose this over SPA)
- **App coexistence**: Replace Fyne entirely — remove fyne dependency (user chose replace)
- **Auth**: None — same trust model as desktop app (user chose no auth)
- **Code structure**: Multi-file Go project (user chose multi-file over single-file)
- **Pull progress**: Live streaming via SSE, proxying Ollama's streaming /api/pull response (user chose live streaming)
- **Config storage**: Keep same path `~/Library/Application Support/ollama-manager/config.json` for backward compatibility

**Research Findings**:
- Gin's `LoadHTMLFS` works with `embed.FS` for embedded templates
- DaisyUI v5 uses CSS-first theming with `@plugin "daisyui/theme"` — no `tailwind.config.js` needed with Tailwind v4
- HTMX SSE extension can receive HTML fragments directly via `sse-swap="message"`
- Gin supports `c.Stream()` for SSE endpoints with proper headers
- Tailwind v4 CLI: `npx tailwindcss -i input.css -o output.css`
- Nord colors map cleanly to DaisyUI semantic tokens
- Go embed patterns: `//go:embed templates/*` and `//go:embed static/*`

### Metis Review
**Identified Gaps** (addressed):
- **Port binding**: Default 8080, configurable via env var `PORT`
- **TLS**: None — localhost only, same trust model as desktop app
- **Pull cancellation**: Not required — Fyne app didn't support cancel either (blocking dialog)
- **Process management**: `go run` / `./ollama-manager` — no daemonization
- **Config migration**: Read existing config.json seamlessly (backward compatible)
- **Server health**: No periodic pinging — refresh button only (same as Fyne)
- **Error UX**: Inline error states + toast notifications via DaisyUI
- **Binary name**: Keep `ollama-manager`
- **Go version**: Keep 1.26.3 (no bump needed)

---

## Work Objectives

### Core Objective
Replace the Fyne desktop GUI with a server-rendered web interface using Gin, DaisyUI (Nord theme), and HTMX, preserving all existing Ollama management functionality in a single deployable binary.

### Concrete Deliverables
- `main.go` — Gin router setup, embed directives, server start
- `handlers/` — HTTP handlers for all routes
- `ollama/` — Ollama API client (refactored from current main.go)
- `config/` — Config persistence (refactored from current main.go)
- `templates/` — HTML templates (layout, pages, partials)
- `static/css/output.css` — Compiled DaisyUI Nord theme
- `static/js/htmx.min.js` — HTMX library
- `tailwind/` — Tailwind CSS source files for building output.css
- Updated `.github/workflows/release.yml` — Node.js + Tailwind build step
- Updated `go.mod` — Remove fyne, add gin

### Definition of Done
- [x] `go build -o ollama-manager` produces a single binary with all assets embedded
- [x] `./ollama-manager` starts web server on port 8080
- [x] All 6 features work via browser (verified with curl + Playwright)
- [x] GitHub Actions release workflow produces binary artifact on tag push
- [x] Fyne dependency removed from go.mod
- [x] Old Fyne binary replaced in git

### Must Have
- All 6 features from current app preserved with equivalent UX
- Single binary deployment (Go embed for templates + static assets)
- DaisyUI Nord theme applied consistently
- HTMX interactivity for model detail expansion, form submissions, delete confirmations
- SSE streaming for pull model progress
- Backward-compatible config.json reading
- Updated GitHub Actions release workflow

### Must NOT Have (Guardrails)
- **MUST NOT**: Add authentication/authorization
- **MUST NOT**: Add database (keep JSON file config)
- **MUST NOT**: Add WebSocket (SSE only for pull progress)
- **MUST NOT**: Add React/Vue/Angular (HTMX + server-rendered only)
- **MUST NOT**: Create Docker/containerization configs
- **MUST NOT**: Add test files (user hasn't requested, no test infra)
- **MUST NOT**: Change Ollama API data types (preserve existing structs)
- **MUST NOT**: Add model search/filtering beyond what Fyne had
- **MUST NOT**: Add model quantization or conversion features
- **MUST NOT**: Add chat/inference UI (this is a manager, not a client)
- **MUST NOT**: Add Makefile, task runners, hot reload, dev servers
- **MUST NOT**: Add PostCSS plugins, custom Tailwind plugins, icon fonts
- **MUST NOT**: Add structured logging, metrics, tracing, health check endpoints
- **MUST NOT**: Add client-side routing or JS frameworks

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: NO
- **Automated tests**: None (project has never had tests, user hasn't requested)
- **Agent-Executed QA**: ALWAYS — every task includes concrete QA scenarios

### QA Policy
Every task MUST include agent-executed QA scenarios. Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Frontend/UI**: Use Playwright — Navigate, interact, assert DOM, screenshot
- **API/Backend**: Use Bash (curl) — Send requests, assert status + response fields
- **Build**: Use Bash — Compile, run, verify binary works

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Foundation + Scaffolding):
├── Task 1: Project scaffolding — create directory structure, go.mod cleanup
├── Task 2: Config module — extract loadConfig/saveConfig from main.go
├── Task 3: Ollama client module — extract API calls from main.go
├── Task 4: Tailwind + DaisyUI setup — input.css, package.json, Nord theme
└── Task 5: Template layout system — base.html, partial.html, navbar

Wave 2 (Core Modules — MAX PARALLEL):
├── Task 6: Server handlers — CRUD routes, server switching
├── Task 7: Model list handler — fetch /api/tags, render model rows
├── Task 8: Model detail handler — fetch /api/show, render detail partial
├── Task 9: Pull model handler + SSE — streaming progress endpoint
├── Task 10: Delete model handler — bulk delete with confirmation
└── Task 11: Dashboard page — combine all sections, stats bar

Wave 3 (UI Polish + Integration):
├── Task 12: HTMX wiring — hx-get, hx-post, hx-delete, hx-confirm
├── Task 13: SSE client integration — HTMX SSE extension for pull progress
├── Task 14: Error states + toast notifications — inline errors, loading states
├── Task 15: Static asset embedding — verify Go embed works
└── Task 16: Build verification — compile, run, manual smoke test

Wave 4 (Release + Cleanup):
├── Task 17: Update GitHub Actions workflow — Node.js + Tailwind build step
├── Task 18: Remove Fyne binary from git — replace with new web binary
├── Task 19: Final integration test — end-to-end via Playwright
└── Task 20: Cleanup — remove old Fyne code, verify go.mod

Wave FINAL (4 parallel reviews):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)
```

### Dependency Matrix

| Task | Depends On | Blocks |
|------|-----------|--------|
| 1 (Scaffolding) | — | 2, 3, 4, 5 |
| 2 (Config) | 1 | 6, 7, 8, 9, 10, 11 |
| 3 (Ollama client) | 1 | 7, 8, 9, 10, 11 |
| 4 (Tailwind/DaisyUI) | 1 | 5, 11, 13 |
| 5 (Templates) | 1, 4 | 11, 12, 13, 14 |
| 6 (Server handlers) | 2 | 11 |
| 7 (Model list) | 2, 3 | 11 |
| 8 (Model detail) | 2, 3 | 11, 12 |
| 9 (Pull + SSE) | 2, 3 | 11, 13 |
| 10 (Delete) | 2, 3 | 11, 12 |
| 11 (Dashboard) | 5, 6, 7, 8, 9, 10 | 12, 13, 14, 15, 16 |
| 12 (HTMX wiring) | 5, 8, 10, 11 | 16 |
| 13 (SSE client) | 4, 9, 11 | 16 |
| 14 (Error states) | 11 | 16 |
| 15 (Asset embed) | 11 | 16 |
| 16 (Build verify) | 12, 13, 14, 15 | 17, 18, 19, 20 |
| 17 (CI workflow) | 16 | — |
| 18 (Remove binary) | 16 | — |
| 19 (Integration test) | 16 | — |
| 20 (Cleanup) | 16 | — |

### Agent Dispatch Summary

- **Wave 1**: T1-T5 → `quick` (scaffolding, config extraction, setup)
- **Wave 2**: T6-T11 → `unspecified-high` (handlers, SSE, dashboard)
- **Wave 3**: T12-T16 → `visual-engineering` + `quick` (HTMX, UI polish, build)
- **Wave 4**: T17-T20 → `quick` + `unspecified-high` (CI, cleanup, integration)
- **FINAL**: F1-F4 → `oracle`, `unspecified-high`, `unspecified-high`, `deep`

---

## TODOs

- [x] 1. Project Scaffolding

  **What to do**:
  - Create directory structure: `handlers/`, `ollama/`, `config/`, `templates/layout/`, `templates/pages/`, `templates/partials/`, `static/css/`, `static/js/`, `tailwind/`
  - Update `go.mod`: remove `fyne.io/fyne/v2` and all fyne indirect deps, add `github.com/gin-gonic/gin`
  - Create `main.go` with Gin router setup, embed directives for `templates/` and `static/`, middleware (HTMX detection), route registration
  - Port binding: default 8080, overridable via `PORT` env var

  **Must NOT do**:
  - Do NOT write any handler logic yet
  - Do NOT create templates yet
  - Do NOT add any middleware beyond HTMX detection and basic recovery

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []
  - Reason: Scaffolding and dependency management

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3, 4, 5)
  - **Blocks**: Tasks 2, 3, 4, 5
  - **Blocked By**: None

  **References**:
  - `go.mod` — Remove `fyne.io/fyne/v2` line and all fyne-related indirect deps
  - Current `main.go:168-456` — Study Fyne app lifecycle to understand what needs replacing
  - Research: Gin `LoadHTMLFS` + `embed.FS` pattern

  **Acceptance Criteria**:
  - [ ] `go mod tidy` completes without errors
  - [ ] `go build -o ollama-manager` compiles (stub main.go is fine)
  - [ ] Directory structure matches plan

  **QA Scenarios**:
  ```
  Scenario: Build succeeds
    Tool: Bash
    Steps:
      1. go mod tidy
      2. go build -o ollama-manager
    Expected Result: Binary created, no compile errors
    Evidence: .sisyphus/evidence/task-1-build-success.txt
  ```

  **Commit**: NO (groups with Wave 1)

- [x] 2. Config Module

  **What to do**:
  - Extract `loadConfig()` and `saveConfig()` from current `main.go:460-500` into `config/config.go`
  - Keep exact same JSON schema and file path (`~/Library/Application Support/ollama-manager/config.json`)
  - Keep legacy fallback to `servers.json`
  - Export functions: `Load()`, `Save()`, `GetServers()`, `GetCurrentServer()`, `SetCurrentServer()`
  - Keep `OllamaServer` struct in config package (or shared types package)

  **Must NOT do**:
  - Do NOT change JSON schema
  - Do NOT change file path
  - Do NOT add encryption
  - Do NOT add validation beyond basic URL check

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []
  - Reason: Straightforward extraction of existing code

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3, 4, 5)
  - **Blocks**: Tasks 6, 7, 8, 9, 10, 11
  - **Blocked By**: Task 1 (directory structure)

  **References**:
  - `main.go:460-500` — Exact loadConfig/saveConfig logic to extract
  - `main.go:124-128` — OllamaServer struct definition

  **Acceptance Criteria**:
  - [ ] `config.Load()` reads existing config.json correctly
  - [ ] `config.Save()` writes config.json correctly
  - [ ] Legacy servers.json fallback works

  **QA Scenarios**:
  ```
  Scenario: Config round-trip
    Tool: Bash (Go test via go run)
    Steps:
      1. Create test config at ~/Library/Application Support/ollama-manager/config.json
      2. Write a small Go program that imports config package, calls Load() and Save()
      3. Verify file contents match after round-trip
    Expected Result: JSON structure preserved, lastUsedServerID maintained
    Evidence: .sisyphus/evidence/task-2-config-roundtrip.txt
  ```

  **Commit**: NO (groups with Wave 1)

- [x] 3. Ollama Client Module

  **What to do**:
  - Extract all Ollama API functions from `main.go:504-592` into `ollama/client.go`
  - Functions: `FetchModels()`, `FetchVersion()`, `FetchModelInfo()`, `PullModel()`, `DeleteModel()`
  - Keep exact same HTTP logic, timeouts, error handling
  - Export `httpClient` or create new one in package
  - Keep `OllamaModel`, `ModelInfo`, `ModelDetails` structs
  - Add `PullModelStream()` that returns `io.ReadCloser` for SSE proxying

  **Must NOT do**:
  - Do NOT change API endpoints or request/response formats
  - Do NOT add retry logic
  - Do NOT change timeout values

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []
  - Reason: Straightforward extraction of existing API client code

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 4, 5)
  - **Blocks**: Tasks 7, 8, 9, 10, 11
  - **Blocked By**: Task 1 (directory structure)

  **References**:
  - `main.go:504-536` — fetchModels
  - `main.go:538-549` — fetchVersion
  - `main.go:551-567` — fetchModelInfo
  - `main.go:569-581` — pullModel
  - `main.go:583-592` — deleteModel
  - `main.go:130-152` — OllamaModel, ModelInfo, ModelDetails structs

  **Acceptance Criteria**:
  - [ ] All 5 API functions compile and have same signatures
  - [ ] `PullModelStream()` returns raw response body for SSE proxying

  **QA Scenarios**:
  ```
  Scenario: API client compiles
    Tool: Bash
    Steps:
      1. go build ./ollama/
    Expected Result: Package compiles without errors
    Evidence: .sisyphus/evidence/task-3-client-compile.txt
  ```

  **Commit**: NO (groups with Wave 1)

- [x] 4. Tailwind + DaisyUI Setup

  **What to do**:
  - Create `tailwind/package.json` with dependencies: `tailwindcss`, `@tailwindcss/cli`, `daisyui`
  - Create `tailwind/input.css` with:
    - `@import "tailwindcss"`
    - `@plugin "daisyui"`
    - `@plugin "daisyui/theme"` with Nord color mapping (see References)
  - Map Nord colors to DaisyUI tokens:
    - base-100: #2E3440, base-200: #3B4252, base-300: #434C5E
    - base-content: #D8DEE9
    - primary: #88C0D0, secondary: #81A1C1, accent: #5E81AC
    - success: #A3BE8C, warning: #EBCB8B, error: #BF616A
  - Build `static/css/output.css` via `npx tailwindcss -i tailwind/input.css -o static/css/output.css`
  - Download `htmx.min.js` (v2.x) to `static/js/htmx.min.js`
  - Download `htmx-ext-sse.js` to `static/js/htmx-ext-sse.js`

  **Must NOT do**:
  - Do NOT create tailwind.config.js (Tailwind v4 is CSS-first)
  - Do NOT add PostCSS plugins
  - Do NOT add custom Tailwind plugins

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []
  - Reason: CSS/setup task

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 3, 5)
  - **Blocks**: Tasks 5, 11, 13
  - **Blocked By**: Task 1 (directory structure)

  **References**:
  - Research: DaisyUI v5 CSS-first theme configuration
  - Nord color palette: https://www.nordtheme.com/docs/colors-and-palettes
  - HTMX: https://htmx.org/ (download minified)
  - HTMX SSE extension: https://htmx.org/extensions/server-sent-events/

  **Acceptance Criteria**:
  - [ ] `static/css/output.css` exists and contains DaisyUI classes
  - [ ] `static/js/htmx.min.js` exists
  - [ ] `static/js/htmx-ext-sse.js` exists
  - [ ] CSS includes Nord theme colors

  **QA Scenarios**:
  ```
  Scenario: CSS builds successfully
    Tool: Bash
    Steps:
      1. cd tailwind && npm install
      2. npx tailwindcss -i input.css -o ../static/css/output.css
      3. grep -q "nord" ../static/css/output.css || grep -q "#88C0D0" ../static/css/output.css
    Expected Result: output.css created, contains Nord colors
    Evidence: .sisyphus/evidence/task-4-css-build.txt
  ```

  **Commit**: NO (groups with Wave 1)

- [x] 5. Template Layout System

  **What to do**:
  - Create `templates/layout/base.html` — full HTML wrapper with:
    - `<html data-theme="nord">`
    - HTMX script tag: `<script src="/static/js/htmx.min.js"></script>`
    - SSE extension: `<script src="/static/js/htmx-ext-sse.js"></script>`
    - CSS link: `<link rel="stylesheet" href="/static/css/output.css">`
    - Navbar with server selector dropdown
    - Main content block: `{{block "content" .}}{{end}}`
  - Create `templates/layout/partial.html` — minimal wrapper for HTMX responses:
    - Just `{{block "content" .}}{{end}}` (no html/head/body)
  - Create `templates/partials/navbar.html` — server selector + stats display
  - Register templates in `main.go` using `template.ParseFS()` with layout, pages, and partials

  **Must NOT do**:
  - Do NOT create page templates yet (those come in Wave 2)
  - Do NOT add client-side routing
  - Do NOT add JS frameworks

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: []
  - Reason: HTML/CSS template design

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 3, 4)
  - **Blocks**: Tasks 11, 12, 13, 14
  - **Blocked By**: Task 1 (directory structure), Task 4 (CSS/JS assets)

  **References**:
  - Research: Gin html/template layout pattern with `{{define}}`/`{{template}}`
  - Current Fyne theme colors (`main.go:54-88`) — match with Nord theme
  - DaisyUI components: https://daisyui.com/components/

  **Acceptance Criteria**:
  - [ ] `templates/layout/base.html` renders valid HTML5
  - [ ] `templates/layout/partial.html` has no html/head/body
  - [ ] Templates parse without errors in Go

  **QA Scenarios**:
  ```
  Scenario: Templates parse correctly
    Tool: Bash (Go test program)
    Steps:
      1. Write small Go program that parses all templates via embed.FS
      2. Execute template "layout/base" with empty data
    Expected Result: No parse errors, produces valid HTML
    Evidence: .sisyphus/evidence/task-5-template-parse.txt
  ```

  **Commit**: NO (groups with Wave 1)

- [x] 6. Server Handlers

  **What to do**:
  - Create `handlers/servers.go` with routes:
    - `GET /servers` — list all servers (for HTMX dropdown refresh)
    - `POST /servers` — add new server (form: name, baseURL)
    - `PUT /servers/:id` — edit server
    - `DELETE /servers/:id` — delete server
    - `POST /servers/:id/select` — set as current server
  - Use `config` package for persistence
  - Return HTML partials for HTMX swaps
  - On add/edit/delete: refresh server list and model list

  **Must NOT do**:
  - Do NOT add server health checking
  - Do NOT add URL validation beyond basic "starts with http"
  - Do NOT add duplicate name checking

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []
  - Reason: Handler logic with state management

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 7, 8, 9, 10, 11)
  - **Blocks**: Task 11
  - **Blocked By**: Tasks 1, 2

  **References**:
  - `main.go:733-875` — showServerForm, showManageServersDialog logic
  - `config/` package from Task 2

  **Acceptance Criteria**:
  - [ ] `POST /servers` creates server and persists to config
  - [ ] `DELETE /servers/:id` removes server and updates config
  - [ ] `POST /servers/:id/select` updates lastUsedServerID

  **QA Scenarios**:
  ```
  Scenario: Server CRUD
    Tool: Bash (curl)
    Steps:
      1. curl -X POST http://localhost:8080/servers -d "name=test&baseURL=http://localhost:11434"
      2. curl http://localhost:8080/servers | grep test
      3. curl -X DELETE http://localhost:8080/servers/1
    Expected Result: Server created, listed, then deleted
    Evidence: .sisyphus/evidence/task-6-server-crud.txt
  ```

  **Commit**: NO (groups with Wave 2)

- [x] 7. Model List Handler

  **What to do**:
  - Create `handlers/models.go` with `GET /models` route
  - Call `ollama.FetchModels(currentServer)`
  - Render `templates/partials/model_list.html` — table/grid of models
  - Each row shows: checkbox, name, quantization, size
  - Include `hx-get` attributes for detail expansion
  - Include `hx-delete` attributes for individual delete

  **Must NOT do**:
  - Do NOT add search/filtering
  - Do NOT add sorting (keep current order)
  - Do NOT add pagination

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []
  - Reason: Handler + template rendering

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 6, 8, 9, 10, 11)
  - **Blocks**: Task 11
  - **Blocked By**: Tasks 1, 2, 3

  **References**:
  - `main.go:247-311` — rebuildModelRows logic
  - `main.go:504-536` — fetchModels
  - `ollama/` package from Task 3

  **Acceptance Criteria**:
  - [ ] `GET /models` returns HTML with model rows
  - [ ] Each row has checkbox, name, quant, size
  - [ ] Empty state shown when no models

  **QA Scenarios**:
  ```
  Scenario: Model list renders
    Tool: Bash (curl)
    Steps:
      1. Start app with test Ollama server
      2. curl http://localhost:8080/models
    Expected Result: HTML contains model names from /api/tags
    Evidence: .sisyphus/evidence/task-7-model-list.txt
  ```

  **Commit**: NO (groups with Wave 2)

- [x] 8. Model Detail Handler

  **What to do**:
  - Create `GET /models/:name/detail` route in `handlers/models.go`
  - Call `ollama.FetchModelInfo(currentServer, name)`
  - Render `templates/partials/model_detail.html` with metadata grid
  - Extract same metadata as Fyne app: format, family, parameter size, quantization, context window, embedding dim, layers, attention heads, KV heads, parameters, temperature, top-p, top-k, num_ctx
  - Use `formatCount`, `formatCtx`, `formatBytes` helpers (extract to `utils/`)

  **Must NOT do**:
  - Do NOT add new metadata fields beyond what Fyne showed
  - Do NOT cache responses

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []
  - Reason: Complex data extraction and template rendering

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 6, 7, 9, 10, 11)
  - **Blocks**: Tasks 11, 12
  - **Blocked By**: Tasks 1, 2, 3

  **References**:
  - `main.go:635-729` — renderModelDetail logic (CRITICAL: preserve exact metadata extraction)
  - `main.go:596-631` — formatBytes, formatCount, formatCtx helpers
  - `ollama/` package from Task 3

  **Acceptance Criteria**:
  - [ ] Detail partial shows all metadata fields from Fyne app
  - [ ] Architecture-specific fields extracted correctly (general.architecture prefix)
  - [ ] Parameters parsed from modelfile text

  **QA Scenarios**:
  ```
  Scenario: Model detail expansion
    Tool: Bash (curl)
    Steps:
      1. curl http://localhost:8080/models/llama2/detail
    Expected Result: HTML contains Format, Family, Parameter size, etc.
    Evidence: .sisyphus/evidence/task-8-model-detail.txt
  ```

  **Commit**: NO (groups with Wave 2)

- [x] 9. Pull Model Handler + SSE

  **What to do**:
  - Create `POST /models/pull` route — accepts `name` form field
  - Create `GET /events/pull/:name` SSE endpoint
  - SSE endpoint:
    - Set headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`
    - Call `ollama.PullModelStream()` to get raw response body
    - Stream JSON lines from Ollama as SSE events
    - Each event: `event: progress\ndata: {"status": "...", "completed": N, "total": N}\n\n`
    - On completion: send `event: complete\ndata: done\n\n`
    - On error: send `event: error\ndata: {"error": "..."}\n\n`
  - Pull handler: return model status partial, trigger SSE connection

  **Must NOT do**:
  - Do NOT buffer entire response before streaming
  - Do NOT use WebSocket
  - Do NOT add pull cancellation (Fyne didn't have it)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []
  - Reason: SSE streaming requires careful goroutine management

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 6, 7, 8, 10, 11)
  - **Blocks**: Tasks 11, 13
  - **Blocked By**: Tasks 1, 2, 3

  **References**:
  - `main.go:569-581` — pullModel logic
  - Research: Gin SSE streaming with `c.Stream()`
  - Ollama API: `/api/pull` streams JSON lines

  **Acceptance Criteria**:
  - [ ] SSE endpoint streams progress events
  - [ ] Final event signals completion
  - [ ] Error events handled gracefully

  **QA Scenarios**:
  ```
  Scenario: SSE pull progress
    Tool: Bash (curl)
    Steps:
      1. curl -N http://localhost:8080/events/pull/llama3
      2. Verify stream contains "event: progress" lines
      3. Verify final "event: complete" line
    Expected Result: Streamed SSE events with progress updates
    Evidence: .sisyphus/evidence/task-9-sse-pull.txt
  ```

  **Commit**: NO (groups with Wave 2)

- [x] 10. Delete Model Handler

  **What to do**:
  - Create `DELETE /models/:name` route — single model delete
  - Create `POST /models/delete` route — bulk delete (form: `names[]`)
  - Call `ollama.DeleteModel()` for each
  - Return empty 200 on success (HTMX removes target element)
  - Return error partial on failure
  - For bulk: iterate selected names, delete each, return updated list

  **Must NOT do**:
  - Do NOT add undo functionality
  - Do NOT add soft delete

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []
  - Reason: Handler logic

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 6, 7, 8, 9, 11)
  - **Blocks**: Tasks 11, 12
  - **Blocked By**: Tasks 1, 2, 3

  **References**:
  - `main.go:395-419` — deleteBtn.OnTapped logic
  - `main.go:583-592` — deleteModel function

  **Acceptance Criteria**:
  - [ ] Single delete returns 200, removes model from list
  - [ ] Bulk delete removes all selected models
  - [ ] Error handling returns proper status

  **QA Scenarios**:
  ```
  Scenario: Delete model
    Tool: Bash (curl)
    Steps:
      1. curl -X DELETE http://localhost:8080/models/llama2
    Expected Result: 200 status, model removed
    Evidence: .sisyphus/evidence/task-10-delete.txt
  ```

  **Commit**: NO (groups with Wave 2)

- [x] 11. Dashboard Page

  **What to do**:
  - Create `GET /` route — main dashboard
  - Render `templates/pages/dashboard.html` extending `layout/base`
  - Include sections:
    - Header: server selector dropdown, stats label (version + model count + total size)
    - Model list: container with `hx-get="/models" hx-trigger="load"`
    - Pull form: input + button with `hx-post="/models/pull"`
    - Delete button: `hx-post="/models/delete"` with selected checkboxes
  - Stats: fetch version + model list, compute total size
  - On server change: reload model list

  **Must NOT do**:
  - Do NOT add dashboard widgets beyond current features
  - Do NOT add real-time updates (polling only on user action)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []
  - Reason: Main page combining all components

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on Tasks 5, 6, 7, 8, 9, 10)
  - **Blocked By**: Tasks 5, 6, 7, 8, 9, 10
  - **Blocks**: Tasks 12, 13, 14, 15, 16

  **References**:
  - `main.go:430-456` — Fyne layout structure (header, model scroll, footer)
  - Current Fyne UI structure: server selector + stats + model list + pull form + delete button

  **Acceptance Criteria**:
  - [ ] Dashboard renders with all sections
  - [ ] Server selector populated from config
  - [ ] Stats show version, model count, total size
  - [ ] Model list loads on page load

  **QA Scenarios**:
  ```
  Scenario: Dashboard loads
    Tool: Playwright
    Steps:
      1. Open http://localhost:8080/
      2. Wait for #model-list to contain .model-row
      3. Screenshot
    Expected Result: Page shows server selector, model list, pull form, delete button
    Evidence: .sisyphus/evidence/task-11-dashboard.png
  ```

  **Commit**: NO (groups with Wave 2)

- [x] 12. HTMX Wiring

  **What to do**:
  - Add `hx-get` to model detail expansion buttons (target: detail panel)
  - Add `hx-post` to pull form (target: model list, swap: beforeend)
  - Add `hx-delete` to delete buttons (target: closest row, confirm: "Delete {name}?")
  - Add `hx-post` to bulk delete (target: model list)
  - Add `hx-get` to refresh button (target: model list)
  - Add `hx-boost="true"` to base layout for navigation
  - Ensure all forms have proper `name` attributes

  **Must NOT do**:
  - Do NOT add custom JS beyond HTMX attributes
  - Do NOT add client-side state management

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: []
  - Reason: Frontend interactivity wiring

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 13, 14, 15, 16)
  - **Blocks**: Task 16
  - **Blocked By**: Tasks 5, 8, 10, 11

  **References**:
  - HTMX docs: https://htmx.org/attributes/
  - Research: HTMX + Go/Gin patterns from librarian

  **Acceptance Criteria**:
  - [ ] Detail expansion works without page reload
  - [ ] Form submissions use HTMX
  - [ ] Delete has confirmation dialog

  **QA Scenarios**:
  ```
  Scenario: HTMX interactivity
    Tool: Playwright
    Steps:
      1. Open http://localhost:8080/
      2. Click model detail expand button
      3. Wait for .model-detail to appear
      4. Click delete button, confirm dialog
    Expected Result: Detail expands inline, delete removes row
    Evidence: .sisyphus/evidence/task-12-htmx.png
  ```

  **Commit**: NO (groups with Wave 3)

- [x] 13. SSE Client Integration

  **What to do**:
  - Add `hx-ext="sse"` to pull progress container
  - Add `sse-connect="/events/pull/{name}"` attribute
  - Add `sse-swap="message"` attribute
  - Create `templates/partials/pull_progress.html` — progress bar + status text
  - Style with DaisyUI progress component
  - On complete event: refresh model list (`hx-trigger="sse:complete"`)

  **Must NOT do**:
  - Do NOT use WebSocket
  - Do NOT add custom JS for SSE handling

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: []
  - Reason: HTMX SSE extension wiring

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 12, 14, 15, 16)
  - **Blocks**: Task 16
  - **Blocked By**: Tasks 4, 9, 11

  **References**:
  - HTMX SSE extension docs: https://htmx.org/extensions/server-sent-events/
  - Research: SSE patterns from librarian

  **Acceptance Criteria**:
  - [ ] Pull progress shows live updates via SSE
  - [ ] Progress bar updates as events arrive
  - [ ] Model list refreshes on completion

  **QA Scenarios**:
  ```
  Scenario: Live pull progress
    Tool: Playwright
    Steps:
      1. Open http://localhost:8080/
      2. Enter model name in pull form, submit
      3. Wait for progress bar to appear and update
      4. Wait for completion, verify model appears in list
    Expected Result: Live progress updates, model added on complete
    Evidence: .sisyphus/evidence/task-13-sse-client.png
  ```

  **Commit**: NO (groups with Wave 3)

- [x] 14. Error States + Toast Notifications

  **What to do**:
  - Create `templates/partials/error.html` — inline error message
  - Add error handling to all handlers:
    - Ollama unreachable: show "Cannot connect to server" message
    - API error: show error detail
    - Invalid input: show validation message
  - Use DaisyUI alert components for errors (alert-error, alert-warning)
  - Add loading states: spinner on refresh, disabled buttons during operations

  **Must NOT do**:
  - Do NOT add global error boundary
  - Do NOT add error logging to file

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: []
  - Reason: UI error handling

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 12, 13, 15, 16)
  - **Blocks**: Task 16
  - **Blocked By**: Task 11

  **References**:
  - DaisyUI alert: https://daisyui.com/components/alert/
  - DaisyUI loading: https://daisyui.com/components/loading/

  **Acceptance Criteria**:
  - [ ] Error states show for unreachable server
  - [ ] Invalid input shows validation error
  - [ ] Loading spinners appear during async operations

  **QA Scenarios**:
  ```
  Scenario: Error handling
    Tool: Playwright
    Steps:
      1. Open http://localhost:8080/ with no Ollama server
      2. Verify error alert is visible
      3. Submit empty pull form, verify validation error
    Expected Result: Graceful error display, no crashes
    Evidence: .sisyphus/evidence/task-14-errors.png
  ```

  **Commit**: NO (groups with Wave 3)

- [x] 15. Static Asset Embedding

  **What to do**:
  - Verify `//go:embed static/*` directive in `main.go`
  - Verify `r.StaticFS("/static", http.FS(staticSub))` serves embedded assets
  - Test that CSS and JS load correctly in browser
  - Verify `//go:embed templates/*` works for all template files
  - Ensure binary runs without external files (standalone)

  **Must NOT do**:
  - Do NOT serve assets from filesystem in production
  - Do NOT add asset versioning/hashing

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []
  - Reason: Verification task

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 12, 13, 14, 16)
  - **Blocks**: Task 16
  - **Blocked By**: Task 11

  **References**:
  - Go embed docs: https://pkg.go.dev/embed
  - Research: Go embed patterns from librarian

  **Acceptance Criteria**:
  - [ ] Binary runs without `static/` or `templates/` directories present
  - [ ] CSS loads and applies styles
  - [ ] HTMX JS loads and works

  **QA Scenarios**:
  ```
  Scenario: Embedded assets work
    Tool: Bash (curl)
    Steps:
      1. go build -o ollama-manager
      2. rm -rf static/ templates/  # remove source dirs
      3. ./ollama-manager &
      4. curl -I http://localhost:8080/static/css/output.css
      5. curl -I http://localhost:8080/static/js/htmx.min.js
    Expected Result: 200 for both assets
    Evidence: .sisyphus/evidence/task-15-embed.txt
  ```

  **Commit**: NO (groups with Wave 3)

- [x] 16. Build Verification

  **What to do**:
  - Run full build: `go build -o ollama-manager`
  - Start server: `./ollama-manager`
  - Smoke test all routes with curl
  - Verify no Fyne imports remain in codebase
  - Check binary size is reasonable
  - Run `go mod tidy` and verify clean

  **Must NOT do**:
  - Do NOT skip any route testing

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []
  - Reason: Build verification

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on Tasks 12, 13, 14, 15)
  - **Blocked By**: Tasks 12, 13, 14, 15
  - **Blocks**: Tasks 17, 18, 19, 20

  **References**:
  - All previous tasks

  **Acceptance Criteria**:
  - [ ] `go build` succeeds
  - [ ] Server starts on port 8080
  - [ ] All routes respond correctly
  - [ ] No Fyne imports in go.mod

  **QA Scenarios**:
  ```
  Scenario: Full build test
    Tool: Bash
    Steps:
      1. go build -o ollama-manager
      2. ./ollama-manager &
      3. curl http://localhost:8080/ | grep -q "Ollama Manager"
      4. curl http://localhost:8080/models | grep -q "model"
      5. grep -r "fyne" go.mod || true
    Expected Result: Build succeeds, routes work, no fyne in go.mod
    Evidence: .sisyphus/evidence/task-16-build.txt
  ```

  **Commit**: NO (groups with Wave 3)

- [x] 17. Update GitHub Actions Workflow

  **What to do**:
  - Update `.github/workflows/release.yml`:
    - Add Node.js setup step (v20+)
    - Add `npm install` in `tailwind/` directory
    - Add `npx tailwindcss -i input.css -o ../static/css/output.css` build step
    - Ensure Go build happens AFTER CSS compilation
    - Keep macOS runner (app is macOS-only)
  - Test workflow syntax with `actionlint` or similar

  **Must NOT do**:
  - Do NOT add multi-arch builds
  - Do NOT add Docker builds

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []
  - Reason: CI configuration

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 18, 19, 20)
  - **Blocked By**: Task 16

  **References**:
  - Current `.github/workflows/release.yml`
  - GitHub Actions docs: https://docs.github.com/en/actions

  **Acceptance Criteria**:
  - [ ] Workflow file is valid YAML
  - [ ] Node.js setup step present
  - [ ] Tailwind build step present
  - [ ] Go build step present

  **QA Scenarios**:
  ```
  Scenario: Workflow syntax valid
    Tool: Bash
    Steps:
      1. cat .github/workflows/release.yml | grep -q "node"
      2. cat .github/workflows/release.yml | grep -q "tailwindcss"
    Expected Result: Workflow contains Node and Tailwind steps
    Evidence: .sisyphus/evidence/task-17-workflow.txt
  ```

  **Commit**: NO (groups with Wave 4)

- [x] 18. Remove Fyne Binary from Git

  **What to do**:
  - Remove old `ollama-manager` Fyne binary from git tracking
  - Build new web binary: `go build -o ollama-manager`
  - Add new binary to git (as was done with Fyne binary)
  - Update `.gitignore` if needed (keep `ollama-manager` ignored for dev builds, but committed binary is the release artifact)
  - Actually: per AGENTS.md, the compiled binary IS checked into git. So:
    - `git rm ollama-manager` (remove old)
    - `go build -o ollama-manager` (build new)
    - `git add ollama-manager` (add new)

  **Must NOT do**:
  - Do NOT remove binary from .gitignore (dev builds should still be ignored)
  - Wait, actually: if binary is in .gitignore, it can't be committed. Need to check...

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []
  - Reason: Git operations

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 17, 19, 20)
  - **Blocked By**: Task 16

  **References**:
  - `.gitignore` — Check if `ollama-manager` is ignored
  - AGENTS.md — "The compiled binary `ollama-manager` is checked into git"

  **Acceptance Criteria**:
  - [ ] Old Fyne binary removed from git
  - [ ] New web binary built and added
  - [ ] Binary runs standalone

  **QA Scenarios**:
  ```
  Scenario: Binary replacement
    Tool: Bash
    Steps:
      1. git rm ollama-manager
      2. go build -o ollama-manager
      3. ./ollama-manager &
      4. curl http://localhost:8080/
    Expected Result: New binary serves web app
    Evidence: .sisyphus/evidence/task-18-binary.txt
  ```

  **Commit**: NO (groups with Wave 4)

- [x] 19. Final Integration Test

  **What to do**:
  - End-to-end test with Playwright:
    - Open dashboard
    - Add a server
    - View model list
    - Expand model detail
    - Pull a model (or verify SSE connection)
    - Delete a model
    - Verify all actions work
  - Test error states: no server, unreachable server
  - Screenshot each step

  **Must NOT do**:
  - Do NOT skip any feature

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: [`playwright`]
  - Reason: Full end-to-end browser testing

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 17, 18, 20)
  - **Blocked By**: Task 16

  **References**:
  - All previous tasks
  - Playwright docs

  **Acceptance Criteria**:
  - [ ] All 6 features work in browser
  - [ ] Screenshots captured for each feature
  - [ ] No console errors

  **QA Scenarios**:
  ```
  Scenario: End-to-end integration
    Tool: Playwright
    Steps:
      1. Open http://localhost:8080/
      2. Add server via form
      3. View model list
      4. Expand model detail
      5. Pull model (verify SSE)
      6. Delete model
    Expected Result: All features functional
    Evidence: .sisyphus/evidence/task-19-e2e/
  ```

  **Commit**: NO (groups with Wave 4)

- [x] 20. Cleanup

  **What to do**:
  - Remove old `main.go` Fyne code (or archive it)
  - Verify `go.mod` has no Fyne imports
  - Verify `go.sum` is clean
  - Remove any leftover Fyne-related files
  - Update AGENTS.md to reflect new architecture
  - Final `go mod tidy`

  **Must NOT do**:
  - Do NOT delete old main.go without ensuring new code works

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []
  - Reason: Cleanup

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 17, 18, 19)
  - **Blocked By**: Task 16

  **References**:
  - `go.mod` — Verify no fyne imports
  - AGENTS.md — Update project description

  **Acceptance Criteria**:
  - [ ] No Fyne imports in go.mod
  - [ ] go.sum is clean
  - [ ] AGENTS.md updated

  **QA Scenarios**:
  ```
  Scenario: Cleanup verification
    Tool: Bash
    Steps:
      1. grep -r "fyne" go.mod go.sum || true
      2. grep -r "fyne" *.go || true
    Expected Result: No Fyne references
    Evidence: .sisyphus/evidence/task-20-cleanup.txt
  ```

  **Commit**: NO (groups with Wave 4)

---

## Final Verification Wave

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, curl endpoint, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in `.sisyphus/evidence/`. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run `go build`, `go vet`, `gofmt -l`. Review all changed files for: unused imports, naked returns, error handling gaps, race conditions. Check AI slop: excessive comments, over-abstraction, generic names.
  Output: `Build [PASS/FAIL] | Vet [PASS/FAIL] | Fmt [PASS/FAIL] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high` (+ `playwright` skill)
  Start from clean state. Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration (features working together). Test edge cases: empty state, invalid input, rapid actions. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance. Detect cross-task contamination.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

- **Wave 1**: `feat(web): scaffold Gin + DaisyUI project structure — "Zoinks!"`
- **Wave 2**: `feat(web): implement server, model, pull, delete handlers — "Ruh-roh!"`
- **Wave 3**: `feat(web): HTMX interactivity, SSE, error states — "Jinkies!"`
- **Wave 4**: `feat(web): CI workflow, binary, cleanup — "Would you do it for a Scooby Snack?"`
- **FINAL**: `feat(web): complete web app conversion — "Scooby-Dooby-Doo!"`

---

## Success Criteria

### Verification Commands
```bash
# Build
go build -o ollama-manager

# Run
./ollama-manager

# Test routes
curl http://localhost:8080/
curl http://localhost:8080/models
curl http://localhost:8080/servers

# Verify no Fyne
grep -r "fyne" go.mod || echo "No Fyne — good"

# Verify embedded assets work
rm -rf static/ templates/
./ollama-manager &
curl -I http://localhost:8080/static/css/output.css
curl -I http://localhost:8080/static/js/htmx.min.js
```

### Final Checklist
- [x] All "Must Have" present
- [x] All "Must NOT Have" absent
- [x] `go build` succeeds
- [x] Binary runs standalone (no external files needed)
- [x] All 6 features work in browser
- [x] Fyne dependency removed
- [x] GitHub Actions workflow updated
- [x] Scooby-Doo quote in commit messages