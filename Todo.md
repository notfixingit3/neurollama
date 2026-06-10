# NEUROLLAMA Roadmap & Feature Todo List

<!-- v0.2.23 — 2026-06-04 -->
<!-- Ollama Remote Update via SSH (System > Settings): password/key auth, macOS .app bundle path, Linux binary swap preserving custom systemd service, pre-flight checks (curl, GitHub API, binary path, service file, sudo creds, disk space) -->
<!-- Three new bench types: tool_use, json_output, instruction_follow; leaderboard bar chart; param size filter; JSON badge; CHAT⚠ rework; halluc ctx warning -->
<!-- Port 8811 default; TRUSTED_PROXIES env var; Dockerfile/compose updated -->

<!-- v0.2.22 — 2026-06-03 -->
<!-- CI: dev compile-check, auto pre-release detection via merge-base -->
<!-- chore: scrubbed all Co-Authored-By trailers from git history (git filter-repo) -->

- [x] **Real-time Telemetry & Performance Graphs**
  - Plot live VRAM/RAM utilization, CPU/GPU temperatures, and generation speed (Tokens Per Second, Time to First Token) on the Memory tab.
- [ ] **Local Document RAG (Retrieval-Augmented Generation) Panel**
  - Integrate a drag-and-drop document upload (PDF, TXT, MD) system that builds a client-side vector index to inject relevant context snippets into your chat.
- [x] **Interactive Modelfile Recipe Builder & Model Merger**
  - Build a visual editor to generate custom model configurations (system prompt, adapters, template structures, model weights merge recipe) and run compilation streams.
- [x] **Chat Session Export & Share Center**
  - Add export utilities to save chat history along with performance telemetry as Markdown, HTML, JSON, or PDF documents.
- [x] **Active Chat Parameter Optimizer (Benchmarking Tool)**
  - Run a benchmarking test suite across different hyperparameter values (Temperature, Top P, Top K) to output a readability and speed optimization report.
- [x] **Structured Prompt Engineering Studio (Templates)**
  - Provide interactive templates for prompting frameworks (Chain-of-Thought, ReAct, Few-Shot, code generation) with variable placeholders.
- [x] **Code Snippet & API Code Generator**
  - Add a copy-paste panel displaying ready-to-run API snippets (`curl`, Python, Node.js, Go) matching the active chat parameters.
- [x] **Automated Model Updates & Scheduler**
  - Implement a background task planner to check the Ollama registry for newer tag builds and download updates during off-peak hours.
- [x] **Context Window Visualizer & Heatmap**
  - Visualize active context window consumption token-by-token or message-by-message, indicating current system prompt space and highlighting content about to be pruned.
- [x] **Automated Context Compression & Auto-Summarizer**
  - Prompt a background summary of older conversation threads when context limits are reached to maintain chat coherence over very long discussions.
- [x] **Multimodal Panel (Image & Vision Input & Base64 Processing)**
  - Support vision-capable models (e.g. LLaVA, BakLLaVA) by providing an image upload/preview area in the playground chat console and encoding images to base64 strings in `/api/chat` payloads.
- [x] **Hugging Face & Ollama Library Model Cards**
  - Fetch and display the full Markdown model description cards from Hugging Face or Ollama registry inside the model details panel.
- [x] **Pause/Resume Model Downloader with Network Speed Graphs**
  - Show download speed timelines (MB/s) and remaining time estimates for active pulls, with support for pausing and resuming downloads.
- [x] **Local Model Benchmark Suite**
  - Run standardized speed and reasoning accuracy tests across installed models, maintaining a local leaderboard ranking hardware performance.
- [x] **Model Clone / Copy Tool (POST /api/copy)**
  - Add a clone action button in Model Inventory to instantly duplicate a model locally under a new name without needing to redownload it.
- [x] **Single-Completion Workspace (POST /api/generate)**
  - Support a separate completion-focused panel (e.g. for code completion, auto-fill, inline editing) that interacts with single-generation endpoints.
- [x] **Additional Options parameters (min_p, presence_penalty, num_predict)**
  - Expose additional Ollama sampler configuration sliders (like `min_p`, `presence_penalty`, `frequency_penalty`, and generation token limits like `num_predict`).
- [x] **Hardware Thread & Layer Allocation Profile (num_gpu, num_thread)**
  - Expose request-level hardware tuning controls (such as GPU layers offload `num_gpu` and CPU threads `num_thread`) inside the playground sidebar settings.

<!-- v0.3.1 — 2026-06-10 -->
<!-- Copy button on user messages; model NOTES tab in INSPECT accordion (localStorage) -->

<!-- v0.3.0 — 2026-06-04 -->
<!-- NeuroWizard: Builder subtabs (Recipe Builder / NEUROWIZARD), 5 wizard modals (ctx, persona, sampling, nothink, merge) -->
<!-- Context window validation extended to completion + builder panels -->

## v0.3.0 Session Notes

- [x] **NeuroWizard hub** — NEUROWIZARD subtab inside Builder workspace. Card grid of 5 wizards; each opens a modal with live Modelfile preview, SSE creation stream, OPEN IN CHAT on success.
- [x] **Expand Context wizard** — model + ctx size selector (8K–256K), ⚠ if exceeds trained max, auto-name `{model}-ctx{n}k`
- [x] **Custom Persona wizard** — 4 role presets (coding/tutor/creative/research) + Custom; SYSTEM prompt auto-filled + editable
- [x] **Sampling Profile wizard** — Creative / Balanced / Precise / Fast presets with baked PARAMETER lines
- [x] **Strip Thinking wizard** — `-nothink` variant via `SYSTEM "/no_think"`; for Qwen3, DeepSeek-R1, QwQ
- [x] **Merge Models wizard** — two model selects, blend weight slider (0.1–0.9), SLERP/Linear method
- [x] **Ctx warning: completion + builder** — `⚠` span added to completion context limit and builder context window; wired to `updateCtxWarning()` via change listeners + `fetchModelCtxLengths()` initial call + `onBaseModelChange()`
- [x] **8 additional NeuroWizards** — Remove Restrictions (clear/neutral/custom), Terse Mode (minimal/ultra-terse/technical), Code Specialist (14 language presets + custom + temp 0.1), Reproducible Output (seed + optional temp lock), Language Lock (14 languages + custom), Format Specialist (7 presets), Character Creator (name + personality + 7 speech styles), RAG-Optimized (strict/balanced/permissive)

## v0.2.21 Session Notes

- [x] **Inventory Sort** — Clickable column headers (Name, Size, Parameters, Modified) with ↑/↓ indicators. New Modified column at `lg:` breakpoint. Sort persists across page changes.
- [x] **Multi-select improvements** — Fixed sort bug in select-all; added CLEAR button and "Select all N" cross-page shortcut. `_sortedModels()` shared helper.
- [x] **"Inventory" subtab renamed to "Model List"**
- [x] **Hover tooltip engine** — `initTooltip()` reads `data-tip` attributes. Applied to cap badges, bench grade badges, sparklines, sort headers, ctx warn, action buttons, footer elements.
- [x] **Chat-only model detection** — `isGreetingResponse()` (18 patterns). Code bench logs CHAT_MODEL + skips judge. Standard bench checks first response, stores `flags:["chat_model"]` in extra_json.
- [x] **CHAT badge in leaderboard** — Amber, clickable, opens Modelfile Fix Wizard.
- [x] **Modelfile Fix Wizard** — Modal with loading/configure/creating/done steps. Editable SYSTEM textarea, live Modelfile preview, overwrite warning, streams creation, OPEN IN CHAT on success. Entry points: INSPECT accordion FIX button + leaderboard CHAT badge.
- [x] **Hallucination heatmap timing** — `total_ms` added to Go cell struct + SSE event + extra_json. Cells show time label below symbol. Rich data-tip with TTFT + total + response.
- [x] **Code/hallucination model select badges fixed** — `_benchModelOption()` + `_setSelectOptions()` helpers ensure param size in option text for all benchmark selects.

## v0.2.x Session Notes

- [x] **README Screenshot Refresh**
  - Replaced `static/img/screenshot.png` with v0.2.20 inventory view (178 models, capability badges, benchmark grade badges). Added `screenshot-benchmarks.png` (leaderboard with sparklines + Run All) and `screenshot-fleet.png` (multi-node fleet overview) as a 2-up row below the hero shot.

- [x] **RAG Embedding Model Selector — Filter to Embedding Models Only**
  - `rag-model-select` now uses `getModelCapabilities()` to group embedding models first in an optgroup, with other models below. Falls back to all models if no embedding models are detected.

- [ ] **RAG: Image-Only / Scanned PDF Handling**
  - If PDF.js extracts empty or near-empty text (image-based PDF, scanned book), the current error "No extractable text found" is a dead end. Add a note in the UI suggesting the user convert via OCR first (e.g. `ocrmypdf`), and consider auto-detecting the scenario by checking if `text.length < 100` despite `numPages > 1`.

- [ ] **RAG: Large Document Batching**
  - For very large documents (500+ chunks), consider batching the embed call into groups of 100-200 chunks and posting them sequentially rather than one massive payload, with per-batch progress updates. Reduces peak memory pressure on Ollama and gives finer-grained progress.

- [x] **RAG Collection Manager**
  - `collection` field on `rag_documents` table (migration: ALTER TABLE ADD COLUMN, default 'Default')
  - Collection input on upload form (datalist combobox: type new or pick existing)
  - Duplicate detection: warns before uploading a file whose name already exists in the index
  - Inline collection rename: click collection badge in document table → input → Enter/blur saves
  - Collection filter in similarity query tester and chat RAG sidebar
  - `GET /api/rag/collections`, `PUT /api/rag/documents/:id/collection`
  - Collection filter propagated to `GetRAGChunksForModel` (chat RAG + similarity query both respect it)

- [ ] **Memory Telemetry: Real Remote VRAM Monitoring**
  - Ollama's `/api/ps` exposes loaded model sizes but not total GPU VRAM capacity or utilization. The VRAM progress bars currently scale against the NEUROLLAMA host machine's RAM which is meaningless for remote servers.
  - Options to explore: (a) let users manually enter total VRAM per registered server so bars are meaningful, (b) add an optional companion lightweight agent on the remote host that exposes `nvidia-smi` stats via a tiny HTTP endpoint, (c) poll Ollama's `/api/version` for any future GPU stats endpoint they add.

- [x] **Context Window: Model-Aware Validation**
  - `⚠` warning now shown on all context selects (chat, completion, builder, code bench, hallucination bench) when selected ctx exceeds the model's trained context length. Tooltip explains Ollama will clamp the value.

- [x] **PDF.js: Self-Host Worker Instead of CDN**
  - Worker script is loaded from `cdnjs.cloudflare.com` at runtime. If the CDN is unreachable (airgapped installs, strict firewalls) PDF upload silently breaks. Vendor `pdf.worker.min.js` into `static/js/` and update the `workerSrc` path. The main `pdf.min.js` would also need to be vendored or loaded locally.

- [ ] **Cold-Start Timeout Audit**
  - Fixed the 10-second timeout for RAG embedding calls. Audit other operations that use `c.HTTPClient` directly (non-streaming model calls, unload, copy) and confirm they either already use a long client or are fast enough that 10s is safe. Model `copy` in particular can be slow for large models.

## Code Review Follow-Up

- [ ] **Local Auth & Safer Network Binding**
  - Add optional password/API-key protection for the web UI and API routes.
  - Make the bind host configurable and default local installs to `127.0.0.1` instead of listening on all interfaces.
  - Update Docker examples to publish `127.0.0.1:8080:8080` by default, with explicit reverse-proxy guidance for public deployments.

- [x] **Stored XSS Hardening Pass (complete)**
  - All known `innerHTML` injection points now use `escapeHTML()`: server/fleet/telemetry cards (v0.2.20), optimizer error messages, RAG upload logMessage, RAG query error div, cross-node search results (name/node/url/paramSize), empty-state query message.

- [ ] **Auto-Compression Current-Turn Fix**
  - When auto-compressing, summarize older history but preserve the current user message in the request sent to Ollama.
  - Add a regression test that proves an over-budget chat still sends both the generated summary and the latest user prompt.

- [ ] **RAG Scaling & Query Performance**
  - Batch large embedding jobs instead of sending all chunks in one request.
  - Avoid loading every stored chunk into memory for every RAG query once collections grow.
  - Store embedding dimensions and reject mismatched vectors before cosine similarity.
  - Add collection/document filters so chat RAG can target a specific corpus instead of every document for an embedding model.

- [ ] **Backend Refactor: Split Main Handlers by Domain**
  - Move server registry, model inventory, chat, RAG, telemetry, scheduler, benchmark, optimizer, diagnostics, and model-card code into focused files.
  - Keep route wiring simple in `main.go` and make each domain easier to test independently.

- [ ] **Handler & Persistence Test Suite**
  - Add `httptest` coverage for API handlers with a temporary SQLite database.
  - Cover server CRUD, settings allowlist behavior, chat persistence, compression edge cases, RAG document lifecycle, and destructive model action validation.
  - Add table tests for URL validation, model-name validation, auth header validation, parameter bounds, and cosine similarity mismatch handling.

## New Ideas From Code Review

- [ ] **Preflight Diagnostics & Repair Console**
  - Add a diagnostics panel that validates Ollama connectivity, auth headers, writable data directories, SQLite migrations, Tailwind asset freshness, Docker image compatibility, and streaming endpoint health before users start a session.
- [ ] **Secure Model Card Renderer**
  - Render Hugging Face and Ollama model cards through a sanitized or sandboxed viewer with external-link warnings, blocked inline scripts/events, and a raw Markdown fallback for untrusted content.
- [ ] **Secret-Safe Node Registry**
  - Redact stored bearer tokens, passwords, and custom header values from normal server-list responses while keeping an explicit edit flow for replacing credentials.
- [ ] **RAG Collection Manager**
  - Add per-document re-indexing, source metadata, embedding dimension checks, duplicate detection, and collection-level filters so chat retrieval can target specific document sets.
- [ ] **Streaming Resilience Toolkit**
  - Add cancel/retry controls, timeout visibility, larger-safe stream parsing, and saved failure diagnostics for chat, generate, pull, benchmark, optimizer, and model-build streams.

- [ ] **Job & Activity Center**
  - Track long-running pulls, model builds, benchmarks, optimizer runs, scheduler checks, and RAG indexing jobs in one activity panel.
  - Add cancel/retry controls, overlap prevention, progress history, and clear terminal-style diagnostics for failed jobs.

- [ ] **Backup / Export / Restore Center**
  - Export and restore chats, presets, benchmarks, optimizer runs, settings, RAG document metadata, and server registry entries with secrets omitted by default.
  - Add an explicit encrypted export option for users who want to include server credentials.

- [ ] **Model-Aware Setup Assistant**
  - Detect installed models, embedding-capable models, vision-capable models, and likely context limits.
  - Recommend safe defaults for chat settings, RAG embedding model selection, and benchmark prompts based on local inventory.

- [ ] **Ollama Web Search Integration**
  - Add an optional web-search mode for chat that calls Ollama's hosted `web_search` API with a user-provided Ollama API key.
  - Support manual search injection first: search query, result count, citations/sources panel, and "send selected results to chat".
  - Add optional `web_fetch` support for fetching a selected result page and injecting a summarized page excerpt.
  - Later, explore agent/tool mode where compatible models can decide when to call `web_search` and `web_fetch`.
  - Keep it off by default, show when external network calls are happening, store the API key as a secret, and enforce result-size/context-budget limits.

- [ ] **Model Capability Badges**
  - Show compact badges/icons in model lists and selectors for known capabilities such as chat/completion, vision, embeddings, thinking, tools, web search available, and web fetch available.
  - Pull first-party capabilities from `/api/show` when available, including Ollama's `capabilities` field and model metadata such as context length.
  - Treat `web_search` and `web_fetch` as app-level tools that require an Ollama API key, then show a separate "tool-ready" indicator only for models that support tool calling well enough for agent mode.
  - Add hover tooltips explaining whether a badge means native model capability, NEUROLLAMA app capability, or Ollama cloud/API-key capability.
  - Cache capability checks so the inventory view does not spam `/api/show` for every refresh.

## Security & Input Validation Backlog

- [ ] **Central Request Validation Layer**
  - Add shared validators for strings, IDs, URLs, model names, chat roles, auth types, settings keys, numeric sampler ranges, and request body sizes.
  - Return consistent `400` responses with concise field-level messages instead of letting invalid values reach Ollama, SQLite, or template rendering.

- [ ] **Server URL / SSRF Guardrails**
  - Validate node URLs as `http` or `https`, disallow embedded credentials, trim trailing slashes consistently, and reject control characters.
  - Add an optional "allow private networks" setting if the UI is ever exposed beyond localhost, since node testing/proxying can otherwise be abused to reach internal services.

- [ ] **Auth Header Validation**
  - Validate custom auth header names against HTTP token rules and block dangerous header names such as `Host`, `Content-Length`, `Transfer-Encoding`, and hop-by-hop headers.
  - Limit auth secret lengths and make sure secrets never appear in logs, diagnostics, model-card output, or frontend state.

- [ ] **Destructive Action Confirmation & Server-Side Validation**
  - Require valid model names for delete, copy, unload, pull, create, benchmark, and optimizer endpoints.
  - Add server-side confirmation tokens or short-lived nonces for destructive UI actions if authentication is added.
  - Consider soft-locking bulk delete unless the selected active server is reachable and the model list was recently refreshed.

- [ ] **Settings Key Allowlist**
  - Restrict `/api/settings` updates to known keys such as `update_schedule`.
  - Validate setting values (`off`, `daily`, `weekly`, etc.) before writing to SQLite.

- [ ] **Request Size & Payload Limits**
  - Set maximum request body sizes for chat, generate, image payloads, RAG document uploads, presets, server registry entries, and Modelfile builds.
  - Add chunk count, chunk length, image size, base64 length, title length, preset length, and system prompt length limits.

- [ ] **Chat Parameter Bounds**
  - Server-side clamp or reject invalid `temperature`, `top_k`, `top_p`, `min_p`, penalties, `num_ctx`, `num_predict`, `num_gpu`, and `num_thread`.
  - Align UI controls and backend validation so impossible values cannot be saved into chats.

- [ ] **RAG Upload Safety**
  - Enforce file type, extracted text length, chunk count, and per-document size limits.
  - Detect near-empty scanned PDFs and show OCR guidance.
  - Store document hashes to prevent accidental duplicate indexing.

- [ ] **Model Card Proxy Hardening**
  - Validate Hugging Face repo names and Ollama library names before building outbound URLs.
  - Limit fetched model-card response size and content type.
  - Prefer DOMPurify or a hardened sanitizer for rendered external Markdown/HTML, and keep raw view escaped.

- [ ] **Security Headers & Dependency Locality**
  - Add HTTP security headers such as `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`, and `Frame-Options`.
  - Self-host Font Awesome, Marked, and PDF.js or add Subresource Integrity pins for CDN assets.

- [ ] **CSRF / Origin Protections**
  - If cookie-based login is added, protect mutating routes with CSRF tokens or same-site cookies plus origin checks.
  - Reject unsafe cross-origin requests for destructive routes.

- [ ] **Secret Storage Upgrade**
  - Keep `servers.json` at `0600`, but add optional OS keychain or encrypted-at-rest storage for bearer tokens, passwords, and custom header values.
  - Add a "rotate/test credentials" flow that does not expose saved secret values back to the browser.

- [ ] **Concurrency Controls for Background Work**
  - Prevent overlapping scheduler checks and manual update checks from pulling the same models simultaneously.
  - Add per-job cancellation contexts and a visible job state machine.

---

## 🐛 Bug: RAG PDF Upload Crashes Browser Tab

**Reproduction**: Upload any non-trivial PDF (e.g. 1.1MB zip-deflate-encoded book) in the RAG panel.

**Root cause analysis** (traced through `static/js/app.js` `handleRAGUpload` and `ollama.go` `GetEmbeddings`):

1. **CDN-fetched PDF.js worker crashes on certain PDFs** *(primary crash vector)*
   - Worker is loaded from `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js` at call time.
   - A "zip deflate encoded" PDF expands compressed image/font streams inside the worker. Peak in-worker memory can be 10–50× the file size. If the worker OOMs or hits a parsing error, the browser kills the tab.
   - Version mismatch between `pdf.min.js` (CDN) and `pdf.worker.min.js` (separate CDN fetch) can also crash the worker silently.
   - **Fix**: Vendor both `pdf.min.js` and `pdf.worker.min.js` into `static/js/`. Already tracked above ("PDF.js: Self-Host Worker").

2. **No file-size guard before attempting parse**
   - `file.arrayBuffer()` loads the entire PDF into browser RAM. For a 1.1MB file the raw buffer is fine, but decompression inside PDF.js can spike to 50–100MB.
   - **Fix**: Reject files > 10MB with a clear error before touching them. Warn at > 5MB.

3. **No hard page-count limit**
   - Code warns at > 50 pages but does not abort. A 500-page technical PDF would loop `getPage()` for minutes and eventually freeze the tab.
   - **Fix**: Hard reject > 150 pages. Warn at > 50.

4. **No AbortController / timeout on `pdfjsLib.getDocument()`**
   - If the PDF.js worker hangs (corrupt PDF, unsupported content), there is no recovery path. The await never resolves and the UI is frozen.
   - **Fix**: Wrap `pdfjsLib.getDocument()` in a `Promise.race()` with a 30-second timeout. Cancel the document load if it fires.

5. **O(n²) string concatenation across pages**
   - `text += pageText + '\n'` creates a new string on each loop iteration. For a 200-page PDF this allocates ~20,000 temporary strings.
   - **Fix**: Use an array of page strings and join at the end: `const pages = []; ... pages.push(pageText); text = pages.join('\n');`

6. **No chunk count cap**
   - A 100,000-char document at 800 chars/chunk = ~125 chunks. A 500,000-char document = ~625 chunks. Each chunk × embedding dimensions (e.g. 768 float64 = 6KB) stays in-memory until the DB write completes.
   - **Fix**: Cap at 400 chunks with a user-visible warning. Consider streaming chunks to the server in batches of 50 rather than one massive payload (already tracked under "RAG: Large Document Batching").

7. **Batch embedding call not chunked on the server**
   - `GetEmbeddings()` in `ollama.go` sends all chunk texts to Ollama's `/api/embed` in one request. For 300 chunks × 800 chars = 240KB request body, plus Ollama must hold all in-flight embeddings in GPU memory simultaneously.
   - **Fix**: Chunk `GetEmbeddings` into batches of 50 server-side. Already tracked under "RAG: Large Document Batching".

**Recommended fix order**:
- [x] Vendor PDF.js locally (`static/js/pdf.min.js` + `static/js/pdf.worker.min.js`) — eliminates the CDN-crash class entirely
- [x] Add file-size guard (> 10MB = hard reject) and page-count guard (> 150 = hard reject) at the top of `handleRAGUpload`
- [x] Add 30s timeout + AbortController on `pdfjsLib.getDocument()`
- [x] Fix string concatenation (array push + join)
- [x] Cap chunk count at 400, batch-embed 50 at a time both client→server and server→Ollama

---

## 📈 Benchmark Area Improvements

### Quick wins
- [x] **Auto-scoring** — Calculate S/A/B/C/F automatically from measured metrics instead of requiring manual RATE clicks.
  - Standard/Vision/LongCtx: `>80 TPS = S`, `50–80 = A`, `25–50 = B`, `8–25 = C`, `<8 = F`
  - Embedding: `>500 ch/s = S`, `200–500 = A`, `50–200 = B`, `10–50 = C`, `<10 = F`
  - Reasoning: `>90% acc = S`, `75–90 = A`, `55–75 = B`, `35–55 = C`, `<35 = F`
  - Auto-score saved via PUT on benchmark completion (notes = 'auto' marker). Manual override via RATE modal strips the marker. "auto" tag shown on auto-scored rows.

- [x] **Summary stats bar** — Slim strip above the leaderboard showing:
  `N runs · M models · Best: <model> @ <metric>`
  Computed client-side from the current filtered set. Recalculates on filter/sort change.

- [x] **CSV export** — "Export CSV" button downloads the currently filtered + sorted leaderboard as a `.csv` file. Built client-side from the fetched data (no new backend route).

- [x] **Improved live log formatting** — Highlighted timing numbers (`TPS`, `ms`, `ch/s`, `%`) in accent colours. `[COMPLETED]` lines bold green, `[ERROR]` lines bold red, `[CANCELLED]` bold yellow. Run separators highlighted cyan.

### Medium effort
- [x] **TPS sparkline per multi-run group** — Tiny SVG bar chart inline in the Metric column for multi-run groups; oldest → newest, latest bar highlighted in accent blue. Works for all benchmark types.

- [x] **Sort + filter persistence** — Save `lbSortCol`, `lbSortDir`, and `currentLbFilter` to `localStorage` so leaderboard state survives page refresh. Keys: `neurollama-bench-sort-col`, `neurollama-bench-sort-dir`, `neurollama-bench-filter`.

- [x] **Run duration display** — Record elapsed wall-clock time from benchmark start to `done` event on the client side. Displayed in the completion log line as `42s` or `1m 18s`. No backend change needed.

- [x] **Inline notes on leaderboard rows** — Click-to-edit note area on all rows (summary + sub-rows). Enter/blur saves, Escape cancels. Always shows faint `+ note` hint when empty.

### Higher effort
- [x] **Parameter size range filter on benchmark leaderboard** — Min/max dual slider (or two number inputs) above the leaderboard to filter results by model parameter count. E.g. show only models ≥ 30B, or only models between 8B and 120B. Parse param size from the model name/details (e.g. `7.6B`, `32B`, `671B`). Works alongside the existing type/benchmark-type filters. Useful for fair comparisons within a size class.

- [x] **Bar chart view** — Add a "Chart" toggle above the leaderboard that replaces the table with an SVG or canvas bar chart comparing the primary metric (TPS / accuracy / cps) across all visible model groups. Same filter state as the table. Toggle back with "Table".

- [x] **Batch run mode** — "Run All" button on standard benchmarks queues all compatible models for the current type/size filter and runs them sequentially. Progress indicator shows `N/total · modelname`. Stop aborts the queue; errors skip to the next model.

---

## 🧪 Capability Badges & Functional Tests

Beyond raw speed benchmarks, NEUROLLAMA should be able to verify *what a model can actually do* and surface that as inventory badges and leaderboard results.

### Inventory badge expansion
The existing badges (VIS, EMB, TOOLS, THINK) are sourced from Ollama's `/api/show` `capabilities` field. Some capabilities require active probing rather than metadata inspection:

- [x] **JSON badge** — Test whether the model reliably outputs valid JSON when instructed. Send a structured output prompt with `format: "json"` in the API request, attempt to parse the response. Badge shown on inventory row if pass rate ≥ threshold. Distinct from TOOLS — many models claim JSON mode without it working reliably.

- [x] **CHAT badge rework** — The current CHAT badge is negative (flags greeting-injection models). Reworked as red **CHAT⚠** badge.

### Tool calling benchmark (new bench type)
- [x] **Tool call accuracy test** — Shipped as "Tool Use" bench type. 8 test cases, 3 tools, scores correct/total, graded S–F.

### Structured output / JSON benchmark (new bench type)
- [x] **JSON reliability test** — Shipped as "JSON Output" bench type. 6 prompts, parses response, checks required fields, graded S–F.

### Conversational / instruction-following benchmark (new bench type)
- [x] **Instruction following test** — Shipped as "Instruction Follow" bench type. 6 cases with judge model evaluation, graded S–F.

### Implementation notes
- All new bench types follow the same SSE streaming pattern as existing types.
- Results stored in the existing `benchmarks` table with a new `bench_type` value (`tool_use`, `json_output`, `instruction_follow`).
- Inventory badges derived from best historical result per model (same pattern as existing grade badges).
- Only offer these bench types for models with the relevant capability badge (TOOLS for tool use; all models for JSON/instruction).

## 🔨 Model Builder Improvements

### Builder UX overhaul
- [ ] **Progressive disclosure UI** — Restructure the builder so casual users see a simple form (name, base model, system prompt, temperature) by default, with an "Advanced" expander revealing the full Modelfile editor, PARAMETER overrides, TEMPLATE, ADAPTER, and MERGE fields. Expert functionality stays intact — it's just hidden until needed. Goal: a new user should be able to create a custom model in under 60 seconds without reading docs.

- [ ] **Live Modelfile preview sync** — As the user fills in the simple-form fields, the raw Modelfile in the advanced editor updates in real time (already partially done for system prompt). Editing the raw Modelfile directly should also sync changes back to the form fields where possible (round-trip parse).

- [ ] **Base model picker with metadata** — Replace the plain text input for the base model with a searchable select populated from the local model inventory, showing param size, ctx, and capability badges inline. Typing a custom name (e.g. a Hub path) still allowed.

- [ ] **Validation & preflight** — Before streaming the `ollama create`, validate: name is not empty, name does not collide with an existing model (warn, not block), base model exists locally, PARAMETER values are in range. Show inline field-level errors, not just a toast.

---

## 🧙 NeuroWizard — Guided Model Operations

A new subsection (tab or modal launcher) offering step-by-step wizards for common model customisation tasks. Each wizard collects only what it needs, previews the generated Modelfile, then streams the result — no Modelfile knowledge required.

### Planned wizards

- [x] **Remove hardcoded system prompt** *(already shipped as "Modelfile Fix Wizard")* — Detects greeting-injection models via CHAT badge; lets user clear or replace the SYSTEM field and creates a clean copy.

- [x] **Expand context window** — Wizard launched from Builder → NEUROWIZARD. Picks model + target ctx (8K–256K), shows ⚠ if over trained limit, auto-names `{model}-ctx{n}k`, streams creation.

- [x] **Set a custom persona** — Presets: Coding Assistant, Language Tutor, Creative Writer, Research Assistant, Custom. SYSTEM prompt auto-filled + editable. Auto-named `{model}-{preset}`.

- [x] **Temperature / sampling profile presets** — Creative / Balanced / Precise / Fast profiles. Parameters shown in live Modelfile preview.

- [x] **Merge / blend two models** — Model A + B selects, blend weight slider (0.1–0.9), SLERP/Linear method, MERGE_METHOD/MERGE_MODEL/MERGE_RATIO comments in Modelfile. Warns on same-model selection.

- [x] **Strip thinking tokens** — Creates `-nothink` variant via `SYSTEM "/no_think"`. Works for Qwen3/DeepSeek-R1/QwQ.

### NeuroWizard launcher
- [x] **Wizard hub panel** — NEUROWIZARD subtab in Builder workspace. Card grid of all 5 wizards; each card opens a modal with live Modelfile preview + SSE streaming creation + OPEN IN CHAT on success.

---

## 🐝 Swarm / Multi-Node Expansion

The current multi-node registry handles basic server switching, status polling, and NvN benchmarking. This section tracks ideas for evolving it into a true swarm management layer.

### Fleet visibility
- [ ] **Fleet dashboard panel** — Dedicated full-page view (beyond the footer pill and popover) showing all registered nodes in a card grid: GPU VRAM used/total, CPU %, active model, Ollama version, latency sparkline over last N polls. Auto-refreshes on a configurable interval.

- [ ] **Per-node model inventory diff** — Side-by-side view of which models are present on each node. Highlight models missing from one or more nodes. One-click pull-to-node to sync a model across the fleet.

- [ ] **Cross-node search** — Search for a model name across all registered nodes simultaneously and show which nodes have it, their versions, and param sizes.

### Swarm operations
- [ ] **Cross-node benchmark runs** — Run a benchmark against the same model on multiple nodes in parallel and compare results side by side (TPS, TTFT, latency). Useful for comparing hardware across nodes or validating that a new node performs as expected.

- [ ] **Load-aware request routing** — When multiple nodes have the same model loaded, route chat/generate requests to the node with the lowest current load (VRAM headroom, active request count). Opt-in per session.

- [ ] **Fleet-wide pull / delete** — Select a model and push a pull or delete operation to all nodes (or a selected subset) simultaneously, with per-node progress streams.

- [ ] **Node health alerts** — Configurable thresholds (e.g. VRAM > 95%, latency > 2s, node offline > 30s) that surface a persistent banner or badge in the footer, and optionally write to a local alert log.

### Node management
- [ ] **Node groups / tags** — Tag nodes (e.g. "production", "dev", "GPU-heavy") and filter the fleet view or benchmark target by tag. Useful when managing a mix of local and remote nodes.

- [ ] **SSH tunnel helper** — Guided setup for reaching a remote Ollama node over SSH port-forwarding without exposing it publicly. Generates the tunnel command and tests connectivity from the UI.
