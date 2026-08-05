# Changelog

All notable changes to NEUROLLAMA are documented here.

---

## [v0.2.25-beta.16] — 2026-08-05

### Fixed
- **Active sub-tab label invisible on hover** — `.bench-subtab:hover` (specificity 0-2-0) overrode `.bench-subtab-active` (0-1-0), so hovering the already-active pill re-applied cyan hover text over its own cyan background, hiding the label and icon. Affected all 15 sub-tab groups sharing the class (Inventory Model List/Hub, Benchmark type selectors, etc). Pinned the active+hover state explicitly.

---

## [v0.2.25-beta.15] — 2026-07-07

### Added
- **neuro-agent CLI extensions** — added a structured `--help` printout and a dedicated `--version` flag to the metrics daemon. Added configuration fallback support for the `NEURO_AGENT_PORT` environment variable.

---

## [v0.2.25-beta.14] — 2026-07-07

### Fixed
- **Docker Image Build Compilation** — corrected a critical issue in [Dockerfile](file:///Users/house/Documents/gitlab/ollama-manager/Dockerfile) where source files were explicitly listed instead of compiled as a directory package (`.`), which previously broke the Docker build after splitting `main.go`. Added `.dockerignore` to exclude bloated dev assets from the build context.

---

## [v0.2.25-beta.13] — 2026-07-07

### Added
- **Database Foreign Key Indexing** — added automatic index creation on `messages(chat_id)`, `rag_chunks(document_id)`, and `rag_documents(embedding_model)` during DB migrations. Eliminates SQLite full-table scans during chat load and vector similarity searches.
- **Graceful Shutdown Interception** — added SIGINT/SIGTERM handlers to main Go process, closing database handles and releasing lock structures cleanly.
- **Ingestion-Time Model Validation** — added database-level validation to block uploading mismatched embedding models to existing collections.
- **Pull Bootstrap Agent Ingestion** — added `/api/fleet/bootstrap` dynamic setup script, `/api/fleet/download-agent/:os/:arch` on-the-fly compiler, and `/api/fleet/register-agent` check-in handler. Supported both Push (SSH) and Pull (Manual Join) options in the fleet UI.
- **Go Unit Test Suite** — introduced standard Go tests (`db_sqlite_test.go`) validating embedding serialization with isolated in-memory unit tests.

### Fixed
- **Dependency Security Vulnerabilities** — resolved 6 active vulnerabilities in `quic-go` and `golang.org/x/crypto/ssh` by upgrading to safe library versions. Fixed `gosec` server Slowloris potential vectors (G112) by defining a `ReadHeaderTimeout` on all `http.Server` config structs.

---

## [v0.2.25-beta.12] — 2026-07-07

### Added
- **Dynamic context-driven timeouts** — removed the fixed 10s HTTP client timeout on Ollama requests in favor of context propagation. Streaming endpoints (chat, generate, builder) propagate client cancellation immediately to conserve remote node GPU resources. Background health pollers employ 3–5s timeouts.
- **Binary float32 vector embeddings** — optimized RAG storage by converting high-dimensional float vectors from verbose JSON strings to compact binary BLOBs, reducing database space by ~70%. Added dimension checks to queries to prevent mismatched models.
- **Data-preserving SQLite migration** — auto-converts all legacy JSON string vectors in `rag_chunks` to binary BLOBs on startup.

### Changed
- **Refactored backend architecture** — decoupled the 8,300+ line `main.go` file into 11 domain-focused handler files (`handlers_servers.go`, `handlers_models.go`, `handlers_chat.go`, `handlers_chat_history.go`, `handlers_fleet.go`, `handlers_benchmarks.go`, `handlers_rag.go`, `handlers_preferences.go`, `handlers_keys.go`, `handlers_diagnostics.go`, and `handlers_optimizer.go`).

### Fixed
- **Code benchmark log formatting mismatch** — resolved a `go vet` compile issue where the overall score string was formatted as a percentage float.

---

## [v0.2.25-beta.11] — 2026-07-02

### Fixed
- **Benchmark "Test All" with Untested filter** — batch queue was built ignoring the untested filter, so tested model names were injected into the model select as non-existent options. The select value silently stayed empty and every batch step bailed immediately with "Please select a model". Queue now always matches what's visible in the dropdown.

---

## [v0.2.25-beta.10] — 2026-07-02

### Changed
- **Themed confirmation dialogs** — replaced all 19 native browser `confirm()` calls with a reusable async `showConfirm()` modal matching the Nord UI (dark bg, cyan title, red CONFIRM, ghost CANCEL). Eliminates OS-level chrome interruptions.

---

## [v0.2.25-beta.9] — 2026-07-01

### Added
- **neuro-agent v0.1.1** — lightweight HTTPS metrics agent (`/health`, `/metrics`) deployed to fleet nodes via SSH. Self-signed ECDSA P256 cert (TLS 1.3), Bearer token auth, cert fingerprint pinning. Config stored in `~/.config/neuro-agent/`; managed by systemd (Linux) or launchd (macOS).
- **Fleet card agent version display** — nodes with a connected agent show their running `neuro-agent` version in the fleet card stats grid.
- **Agent outdated indicator** — when a node's agent version differs from the version NEUROLLAMA expects (`/healthz` now returns `agent_version`), the version label turns amber with an up-arrow badge and the satellite dish button highlights with a tooltip showing the version delta.
- **SSH credential storage per node** — SSH user, port, and key ID used during agent deploy are persisted on the server record. The satellite dish "Update agent" button pre-fills those credentials automatically so re-deploys require only a password.
- **Satellite dish update button on fleet cards** — quick-action button on each online node that opens the agent deploy panel scrolled into view with node and SSH fields pre-populated.

### Fixed
- **Intel Arc GPU `integrated` flag** — discrete Arc/DG1/DG2 cards were incorrectly marked as integrated when VRAM was undetectable (e.g. ReBAR disabled). Fixed with `isIntelDiscreteGPU()` name-based check.
- **Intel Arc A380 VRAM detection** — cards using the `i915` driver (no sysfs `mem_info_vram_total`, no xe/xpu-smi support) now fall back to a PCI device ID lookup table. `0x56a5` (Arc A380) resolves to 6 GB.
- **`intel_gpu_top` compatibility** — older installed versions don't support `-n 1`. Switched to `exec.CommandContext` with a 2.5 s timeout; last valid JSON object is extracted from the streamed output by scanning backwards.
- **Satellite dish button workspace navigation** — button was navigating to the System workspace instead of Fleet. Fixed to use `switchWorkspace('fleet')` with double `requestAnimationFrame` to ensure the DOM is laid out before scrolling.

---

## [v0.2.25-beta.8] — 2026-07-01

### Added
- **neuro-agent v0.1.0** — new sub-project (`neuro-agent/`) providing a standalone HTTPS metrics agent for fleet nodes. Exposes CPU, memory, disk, GPU (NVIDIA via `nvidia-smi`, AMD via ROCm sysfs, Intel via `intel_gpu_top` + sysfs + lspci BAR), Ollama version, loaded models, and OS/arch. Single binary, zero dependencies.
- **Fleet node agent integration** — NEUROLLAMA polls each node's `neuro-agent` on its configured port, merging hardware telemetry into fleet card display (CPU/GPU stats, VRAM bars, hostname, OS/arch).
- **SSH agent deploy** — Fleet workspace "Deploy Agent" panel SSHes into a node, uploads the compiled `neuro-agent` binary, installs it as a systemd service (Linux) or launchd agent (macOS), and reads back the API key + TLS fingerprint automatically.
- **Node detail modal** — clicking a fleet card opens a modal with full hardware details including per-GPU VRAM breakdown.

---

## [v0.2.25-beta.7] — 2026-07-01

### Added
- **Progressive Disclosure UI for Model Builder** — Restructured the Model Builder layout to display core parameters (Name, Base model, System directive, Temperature) on a clean, simple form by default, while grouping expert settings (Context size, Custom stops, LoRA adapters, templates, merges) inside a collapsible Advanced details panel.
- **VRAM Telemetry on Fleet Cards** — Calculates active node VRAM footprint using loaded model sizes from `/api/ps` scaled against manually configured GPU capacity, rendering a real-time progress bar indicator.
- **Unload model from VRAM** — Added a quick-action button next to loaded models on Fleet cards that sends an unload command (`POST /api/nodes/:id/unload`) to eject the model from remote GPU memory.
- **Active Model telemetry endpoint integration** — Expanded `NodeOverviewEntry` with active model telemetry list (`ActiveModels`) and configured memory metrics (`VramGB`).

### Fixed
- **DaisyUI v5 Component Cleanup** — Removed the deprecated `-bordered` input variant from dynamic adapter inputs in the Model Builder to align with v5 styling guidelines.

---

## [v0.2.25-beta.6] — 2026-06-19

### Added
- **Running models on fleet cards** — each node card in the Fleet grid now shows which models are currently loaded in VRAM. Model names are polled via `/api/ps` every 15 s and rendered as small badges (`:latest` suffix stripped). The running cache is also cleared on manual node refresh so the badge updates immediately.

### Fixed
- **Leaderboards re-render on server switch** — `selectServer()` now calls all leaderboard render functions when the node filter is active, so switching the active node immediately narrows the benchmark results without requiring a manual refresh.
- **Linux service restore: auto-repair missing `[Unit]` header** — the restore command now checks for a `[Unit]` section and prepends one if absent, fixing a subtle systemd issue where hand-crafted service files without the header caused `Description=` and `After=` to be silently ignored.
- **macOS nohup fallback when launchctl fails over SSH** — after `launchctl load`, the restart phase checks whether `ollama` actually started; if not (expected over SSH — no GUI/WindowServer session), it falls back to `nohup` with the full env var set and emits a warning. The plist is still correctly written for automatic activation on next GUI login.

---

## [v0.2.25-beta.5] — 2026-06-13

### Fixed
- **macOS update: probe `com.ollama.serve.plist`** — added as a third candidate plist filename alongside `com.ollama.plist` and `com.ollama.ollama.plist`; all three are used by different Ollama install methods.

---

## [v0.2.25-beta.4] — 2026-06-13

### Fixed
- **Benchmark SSE connection drop on thinking models** — `runBenchmarkForPrompt` had a `logFunc` parameter it never used during the token scan loop. For thinking models (e.g. `qwen3.5`, `qwq`) that generate silently for minutes before producing a response, the SSE stream wrote nothing to the browser, causing EventSource to drop the connection with a generic empty-data error ("Failed to complete benchmark runs."). Now emits a progress heartbeat every 5 s (token count + elapsed time) to keep the connection alive.

---

## [v0.2.25-beta.3] — 2026-06-13

### Added
- **Node filter toggle on all benchmark leaderboards** — a `Node` pill button (default ON) limits results to the currently selected node across all five leaderboard/history views: standard benchmark leaderboard, code bench lang leaderboard, code bench run history, hallucination leaderboard, and hallucination run history. Toggle persisted to preferences. Clicking the button on any leaderboard syncs all three toggle buttons simultaneously.

---

## [v0.2.25-beta.2] — 2026-06-13

### Fixed
- **macOS Ollama update: plist rewritten on every update** — the Ollama GUI wrapper (`Contents/MacOS/Ollama`) does not support the `serve` subcommand; the bundled CLI at `Contents/Resources/ollama` does. The plist is now rewritten via `PlistBuddy` after each update to point to the correct binary, which was silently preventing Ollama from starting via launchd after an update.
- **macOS Ollama update: env vars preserved across updates** — OLLAMA_* vars (e.g. `OLLAMA_NUM_PARALLEL`, `OLLAMA_KEEP_ALIVE`, `OLLAMA_FLASH_ATTENTION`) are snapshotted from the running process before it is stopped and restored into the plist (and `nohup` fallback) after the new app is installed. `OLLAMA_HOST=0.0.0.0` is always enforced so remote nodes remain reachable.

---

## [v0.2.25-beta.1] — 2026-06-13

### Changed
- **Ollama Remote Update moved to Fleet** — SSH into a node and upgrade Ollama now lives below the node grid in Fleet, where node management belongs. Settings no longer has it.
- **SSH Key Store moved to Fleet** — keys are used exclusively for node SSH auth; they now live next to the Update Ollama form that consumes them. Fleet has three panels: node grid, Update Ollama, SSH Key Store.
- **Settings simplified** — now contains only the Model Update Scheduler; cleaned up from 12-column grid to flat flex layout.

### Fixed
- HOME dashboard Recent Activity and Top Models now populate on first load without requiring a prior Inventory or Activity tab visit (`seedActivityFromDB()` seeds the last 20 benchmark runs on startup; lazy `fetchModelBenchSummary()` fires when switching to HOME).

---

## [v0.2.25-beta.0] — 2026-06-13

_(superseded by beta.1)_

---

## [v0.2.24] — 2026-06-13

### Added
- **HOME dashboard tab** — landing page with four live stat chips (models, nodes, RAG docs, benchmarks), node status cards, activity feed (last 6 entries), top-6 benchmark performers, and quick-action buttons to the main workspaces. Data pulled from existing global state; RAG doc count lazy-fetched and cached.
- **Chat message branching** — `fa-code-branch` button (hover-reveal, mauve) on every user and assistant chat bubble. User-message button rewinds before that message and restores the text to the input; assistant-message button rewinds to just after that response. Aborts any in-flight stream before trimming. Backend: `TrimChatMessages()` + `POST /api/chats/:id/trim`.
- **Chat auto-title** — first message sent in a new chat auto-generates a title from the first 60 characters of the prompt (trimmed at word boundary). Backend: `PATCH /api/chats/:id/title` using the existing `UpdateChatTitle` DB helper.
- **Inline chat rename** — pencil icon appears on hover in the chat sidebar; clicking replaces the title with an editable input (Enter/blur saves, Escape cancels).
- **NeuroWizard** (Builder → NEUROWIZARD subtab) — 13 guided model operations with live Modelfile preview and SSE creation streams: Expand Context, Custom Persona, Sampling Profile, Strip Thinking, Merge Models, Remove Restrictions, Terse Mode, Code Specialist, Reproducible Output, Language Lock, Format Specialist, Character Creator, RAG-Optimized.
- **Model NOTES tab** in INSPECT accordion — personal scratch-pad per model; auto-saves to `localStorage` and persists server-side via `PUT /api/preferences` across browsers and devices.
- **RAG Collection Manager** — `collection` column on `rag_documents`, inline-editable collection badge, collection filter in query tester and chat sidebar. Routes: `GET /api/rag/collections`, `PUT /api/rag/documents/:id/collection`.
- **Activity center improvements** — category filter pills, badge counting new events, export button, new `rag` and `optimizer` categories.
- **Copy button on user messages** — hover-reveal clipboard icon in chat header of every user message.
- **Context window validation** — `⚠` warning covers all five panels: chat, code bench, hallucination bench, completion workspace, and builder recipe.

### Fixed
- White background on bare `btn` elements (GitHub, HuggingFace, Buy Me a Coffee, bench-type-btn selectors) — DaisyUI v5 Nord theme `--b1` is light `#ECEFF4`; added `bg-transparent` to affected elements.
- HOME dashboard Recent Activity and Top Models sections now populate on first load without requiring a prior visit to Inventory or the Activity tab.
- CI version injection: `const appVersion` → `var appVersion` so `-ldflags -X` can override it; binaries now self-report the correct git tag.

### Removed
- Dead code `PruneChatMessages` (never called; superseded by `TrimChatMessages`).

---

## [v0.2.24-beta.0] — 2026-06-13

### Added
- **HOME dashboard tab** — landing page with four live stat chips (models, nodes, RAG docs, benchmarks), node status cards, activity feed (last 6 entries), top-6 benchmark performers, and quick-action buttons to the main workspaces. Data pulled from existing global state; RAG doc count lazy-fetched and cached.
- **Chat message branching** — `fa-code-branch` button (hover-reveal, mauve) on every user and assistant chat bubble. User-message button rewinds before that message and restores the text to the input; assistant-message button rewinds to just after that response. Aborts any in-flight stream before trimming. Backend: `TrimChatMessages()` + `POST /api/chats/:id/trim`.
- **Chat auto-title** — first message sent in a new chat auto-generates a title from the first 60 characters of the prompt (trimmed at word boundary), replacing the `Chat // HH:MM:SS` placeholder. Backend: `PATCH /api/chats/:id/title` using the existing `UpdateChatTitle` DB helper, now finally wired to a route.
- **Inline chat rename** — pencil icon appears on hover in the chat sidebar alongside the existing delete button; clicking replaces the title with an editable input (Enter/blur saves, Escape cancels).
- **NeuroWizard** (Builder → NEUROWIZARD subtab) — 13 guided model operations with live Modelfile preview and SSE creation streams:
  - Expand Context, Custom Persona (4 presets), Sampling Profile (Creative/Balanced/Precise/Fast), Strip Thinking (`/no_think`), Merge Models (SLERP/Linear), Remove Restrictions (clear/neutral/custom), Terse Mode (3 variants), Code Specialist (14 lang presets + temp 0.1), Reproducible Output (seed + temp lock), Language Lock (14 langs), Format Specialist (7 presets), Character Creator (name + personality + 7 speech styles), RAG-Optimized (3 strictness levels)
- **Copy button on user messages** — hover-reveal clipboard icon in the chat header of every user message, matching the existing assistant copy button.
- **Model NOTES tab in INSPECT accordion** — personal scratch-pad per model; auto-saves to `localStorage` on keystroke (debounced 500ms) and persists server-side via `PUT /api/preferences` so notes survive across browsers and devices.
- **Context window validation** — `⚠` warning now covers all five panels: chat, code bench, hallucination bench, completion workspace, and builder recipe.
- **RAG Collection Manager** — `collection` column on `rag_documents`, inline-editable collection badge per document, collection filter in query tester and chat RAG sidebar. Routes: `GET /api/rag/collections`, `PUT /api/rag/documents/:id/collection`.
- **Activity center improvements** — category filter pills (ALL/PULL/BUILD/BENCH/MODEL/RAG/OPT/NODE/SYS), badge counting new events, export button for filtered log as timestamped `.txt`, new `rag` and `optimizer` categories.
- **Builder inline validation** — amber border + collision warning on name conflict; red border + block on invalid characters.

### Fixed / Improved
- `PruneChatMessages` dead code removed; `TrimChatMessages` (keep-first-N semantics) is the active helper.
- Branch pre-fill strips `<think>…</think>` blocks before restoring text to the input.
- Branch button aborts any in-flight generation before trimming.
- `appVersion` changed from `const` to `var` so CI can inject the git tag via `-ldflags "-X main.appVersion=<tag>"`. Workflow updated to pass both `appVersion` and `releaseType` at build time.
- XSS: all known `innerHTML` injection points use `escapeHTML()` — complete audit as of this release.

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
