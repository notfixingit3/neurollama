# Changelog

All notable changes to NEUROLLAMA are documented here.

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
