# Changelog

All notable changes to NEUROLLAMA are documented here.

---

## [v0.3.1] — 2026-06-10

### Added
- **Copy button on user messages** — hover-reveal clipboard icon in the chat header of every user message, matching the existing copy button on assistant messages. Uses the same `copyMessageToClipboard` flow (checkmark feedback + toast).
- **Model NOTES tab in INSPECT accordion** — personal scratch-pad per model alongside FILE/PARAMS/TEMPLATE/SYSTEM/CARD. Auto-saves to `localStorage` on every keystroke; clearing the textarea removes the key. The tab-content copy button hides while NOTES is active.

---

## [v0.3.0] — 2026-06-04

### Added
- **NeuroWizard** (Builder → NEUROWIZARD subtab) — guided model operations, no Modelfile knowledge required:
  - **Expand Context** — set a larger `num_ctx` for any model with a context-window warning if it exceeds the trained max
  - **Custom Persona** — apply a SYSTEM prompt from presets (Coding Assistant, Language Tutor, Creative Writer, Research Assistant) or freeform custom text
  - **Sampling Profile** — bake Creative / Balanced / Precise / Fast temperature presets into a new Modelfile variant
  - **Strip Thinking** — create a `-nothink` variant via `/no_think` SYSTEM directive (Qwen3, DeepSeek-R1, QwQ, etc.)
  - **Merge Models** — blend two models with configurable weight and SLERP/Linear method
  - Each wizard: live Modelfile preview, SSE streaming creation log, OPEN IN CHAT shortcut on success
- **8 additional NeuroWizards**:
  - **Remove Restrictions** — strips or replaces baked-in SYSTEM prompt; modes: Clear / Neutral baseline / Custom
  - **Terse Mode** — three "no fluff" variants: Minimal / Ultra-terse / Technical
  - **Code Specialist** — locks to code-only output for a chosen language + temperature 0.1; includes custom language entry
  - **Reproducible Output** — bakes in fixed seed + optional temperature lock for deterministic responses
  - **Language Lock** — forces responses in a chosen language (14 presets + custom)
  - **Format Specialist** — 7 output/style presets: Markdown, Plain Text, JSON Only, Bullet Points, Academic, Socratic, Devil's Advocate
  - **Character Creator** — named character with personality, speech style (7 options), and backstory
  - **RAG-Optimized** — 3 strictness levels (Strict / Balanced / Permissive) for context-grounded Q&A
- **Context window validation** now covers all panels: completion workspace and builder recipe now also show the `⚠` warning when selected context exceeds the model's trained maximum (chat, code bench, and hallucination bench already had it)

---

## [v0.2.23] — 2026-06-04 (stable)

### Added
- **Ollama Remote Update** (System → Settings) — update Ollama on any registered node via SSH without leaving the UI.
  - Auth: SSH password (with keyboard-interactive fallback) or existing key (`~/.ssh/id_ed25519/ecdsa/rsa`)
  - **Linux**: downloads the binary directly from GitHub releases and swaps it + restarts the systemd service. The installer is intentionally *not* used so custom `ollama.service` files (custom model paths, env vars, Vulkan flags, etc.) are preserved.
  - **macOS**: detects `.app` bundle vs plain CLI install. Bundle path downloads `Ollama-darwin.zip`, extracts with `ditto`, replaces `/Applications/Ollama.app`, clears quarantine, and restarts via `open`. CLI path falls back to the official install script.
  - **Pre-flight checks** run before downloading anything — any fatal failure aborts immediately:
    - Common: `curl` available, GitHub API reachable from remote host
    - Linux: `systemctl` present, Ollama binary in PATH, `/etc/systemd/system/ollama.service` exists, service enabled (warning), sudo credentials valid (dry-run), `/tmp` ≥ 100 MB free
    - macOS: `ditto`/`open` available, `Ollama.app` exists, `/Applications/` writable, `/tmp` ≥ 400 MB free
  - Terminal-style output log with colour-coded `✔`/`⚠`/`✖` check results and `old → new` version diff on completion
- **Three new benchmark types**: tool use, JSON output, instruction follow — each with SSE run endpoint, accuracy-based scoring (S/A/B/C/F), and leaderboard integration
- **Leaderboard bar chart** — toggle between table and SVG bar chart view; colour-coded by benchmark type
- **Param size range filter** — min/max B filter on the leaderboard; `parseParamB()` handles K/M/B/T suffixes
- **JSON capability badge** — probe any model for JSON output support; results cached in localStorage; `Probe All` button in inventory toolbar
- **CHAT⚠ badge** — redesigned in red to more clearly flag chat-only models that skip task instructions
- **Hallucination ctx warning** — `⚠` shown in Max Context Size label when the selected context exceeds the model's trained context window; correctly handles K-unit values in the hallucination selector

### Changed
- **Default port** changed from `8080` to `8811` — too many things already default to 8080
- **TRUSTED_PROXIES** env var — defaults to `127.0.0.1,::1`; supports `"none"` to disable trust; configurable for Traefik/reverse-proxy setups
- Dockerfile `EXPOSE` and healthcheck updated to port 8811
- `docker-compose.yml` port mapping and healthcheck updated to 8811

### Fixed
- Model selector in hallucination benchmark showed only the parameter value — trigger element made `display:flex` so name and badges are always visible
- `ollama-darwin.tgz` is x86_64-only; macOS arm64 nodes (Apple Silicon) now correctly receive `Ollama-darwin.zip` (universal .app bundle)
- Linux remote update 404 — Ollama dropped plain binary assets; now uses official install script with service file backup/restore
- GitHub API tag parse failed on pretty-printed JSON (`"tag_name": "v..."` with space) — switched to `sed` pattern
- SSH key auth failed when keys are passphrase-protected — now uses SSH agent (`SSH_AUTH_SOCK`) first, with DB-stored keys as Docker/agent-less fallback
- `gosec` audit: 0 issues (real fixes + 6 justified `#nosec` annotations)

---

## [v0.2.22] — 2026-06-03

### Added
- **CI: compile-check on dev pushes** — new `build-check` job runs `go build` on every push to `dev` so broken commits are caught before tagging.
- **CI: auto pre-release detection** — `check-stable` job uses `git merge-base --is-ancestor` to determine if a tagged commit is on `main`; tags on `dev` produce GitHub pre-releases automatically, tags after main promotion produce stable releases.

### Changed
- **Commit history scrubbed** — all `Co-Authored-By` trailers removed from the full commit history via `git filter-repo`. All 127 commits rewritten; all tags recreated on new SHAs.

---

## [v0.2.21] — 2026-06-03

### Added
- **Inventory sort**: click any column header (Name, Size, Parameters, Modified) to sort ascending/descending. Sort state is maintained across page changes.
- **Modified column**: new `lg:`-breakpoint column in the Model List table with a sortable date header.
- **Multi-select improvements**: fixed sort bug in select-all (now uses sorted page view); added CLEAR button and "Select all N" cross-page shortcut to the batch-actions bar.
- **Hover tooltip engine**: lightweight cursor-following tooltip system (`initTooltip()`) triggered by `data-tip` attributes — Nord dark style, 130ms delay, viewport-clamped. Applied to capability badges, benchmark grade badges, TPS sparklines, sort headers, context warnings, action buttons, and footer elements.
- **Chat-only model detection** (`isGreetingResponse()`): detects models that output a welcome greeting instead of following task prompts. Code benchmark logs `CHAT_MODEL` and skips the judge. Standard benchmark checks the first response and stores `flags:["chat_model"]` in `extra_json`.
- **CHAT badge in leaderboard**: amber clickable badge on standard benchmark rows where greeting was detected. Tooltip explains the issue. Click opens the Modelfile Fix Wizard directly.
- **Modelfile Fix Wizard**: guided modal accessible from any model's INSPECT accordion (amber FIX button) or from a CHAT badge in the leaderboard. Fetches the current Modelfile via `/api/show`, shows the SYSTEM prompt (editable), previews the generated Modelfile, and streams model creation via the existing `/api/models/create` endpoint. Defaults new name to `<original>-clean`. OPEN IN CHAT button on success.
- **Hallucination heatmap timing**: each cell now shows the total generation time (`0.3s` / `1.2s`) below the ✓/✗/? symbol. Tooltip shows status + TTFT + total time + model response. `total_ms` added to the SSE cell event and persisted in `extra_json`. Backwards compatible — old runs show no time label.
- **Code/hallucination model select badges**: `populateCodeBenchModelSelects()` now builds options with `name (paramSize)` format so the searchable select widget can render size and context badges, matching all other model selects.

### Changed
- **"Inventory" subtab renamed to "Model List"** — clearer label, panel heading updated to match.
- `runBenchmarkForPrompt` now returns `responseHead string` (first 300 chars) alongside metrics — used by the standard benchmark for greeting detection.
- `toggleSelectAllModels` now uses the sorted model view so select-all matches what's visible on screen.
- `_setSelectOptions` helper extracted: sets innerHTML + calls `_ssWidget.refresh()` consistently for all benchmark model selects.

### Fixed
- Hallucination model select (`halluc-model`) was rebuilt without param size in option text when the untested filter was active, causing the searchable select widget to show no size/context badges.
- `toggleSelectAllModels` was operating on the raw (unsorted) model array instead of the current sorted page view.

---

## [v0.2.20] — 2026-05-29

### Added
- **Inline note editing** on all benchmark leaderboard rows (summary + sub-rows): click any note area to edit in-place — Enter/blur saves via `PUT /api/benchmarks/:id/score`, Escape cancels.
- **Context-size warning (⚠)** on chat and code bench ctx selects: fires on initial load and on change — shows amber warning when selected ctx exceeds the model's trained context length.
- **Benchmark summary auto-refresh**: all four benchmark done handlers (standard, NvN, code, hallucination) now call `fetchModelBenchSummary()` so inventory grade badges update without a page reload.
- **TPS sparkline** on multi-run leaderboard rows: 52×14px SVG bar chart (oldest → newest, latest bar highlighted in `#88c0d0`).
- **Model capability badges**: **TOOLS** (green wrench) and **THINK** (teal lightbulb) added alongside existing VIS/EMB badges. Sourced from Ollama's `/api/show` `capabilities` field via new `GET /api/models/capabilities` endpoint; heuristic fallback for older Ollama.
- **Batch benchmark "Run All"**: queues all compatible models sequentially with `N/total · modelname` progress indicator and stop support.
- **RAG embedding model selector**: `<optgroup>` separates embedding models from other models in both RAG selects.
- **XSS hardening** (partial): server registry cards, fleet node cards, scheduler logs, and active-model telemetry — all user/server/model data through `escapeHTML()`.
- **Fresh README screenshots**: 1440px inventory hero + 2-up benchmarks/fleet layout.

### Changed
- `populateBenchmarkModelSelect` refactored to use shared `getCompatibleBenchmarkModels()` helper with Set-based O(1) lookup.
- `main` branch set as default; repo description and topics updated on GitHub.

### Fixed
- Untested-only filter going stale after benchmark completion on NvN, code, and hallucination tabs.
- `ctx` warning not firing on initial load (now called after `fetchModelCtxLengths()` resolves).

---

## [v0.2.19] — 2026-05-22

### Added
- User badge + Dark/Light/System theme preferences with anti-FOUC inline script.
- Inventory benchmark grade badges (std/code/hallu) + ctx-length badges on every row.
- Untested-only filter on NvN, code, and hallucination tabs (auto-refreshes after run).
- Thinking-model suppression for code/hallucination benchmarks: `/no_think` prompt suffix + `Think: false` API field.
- Safety-refusal detection (`isRefusalResponse`): logs `REFUSED`, skips syntax check + judge, records result.
- Inventory search: CLONE/DELETE restored; `inspectModelFromSearch()` wrapper for cross-node results.

### Fixed
- System prompt override removed from code generation requests (was causing over-aligned models to refuse FizzBuzz).
- Search filter reapplied after model delete (`crossNodeSearchQuery` check in `fetchModels`).
