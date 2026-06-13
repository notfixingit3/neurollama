# Changelog

All notable changes to NEUROLLAMA are documented here.

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
