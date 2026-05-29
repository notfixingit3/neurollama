# NEUROLLAMA Roadmap & Feature Todo List

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

## v0.2.x Session Notes

- [ ] **README Screenshot Refresh**
  - Take a new screenshot of the current UI (accordion inspection panel, updated tab order, playground layout) and replace `static/img/screenshot.png`. Chrome extension was unavailable during v0.2.0 release.

- [x] **RAG Embedding Model Selector — Filter to Embedding Models Only**
  - `rag-model-select` now uses `getModelCapabilities()` to group embedding models first in an optgroup, with other models below. Falls back to all models if no embedding models are detected.

- [ ] **RAG: Image-Only / Scanned PDF Handling**
  - If PDF.js extracts empty or near-empty text (image-based PDF, scanned book), the current error "No extractable text found" is a dead end. Add a note in the UI suggesting the user convert via OCR first (e.g. `ocrmypdf`), and consider auto-detecting the scenario by checking if `text.length < 100` despite `numPages > 1`.

- [ ] **RAG: Large Document Batching**
  - For very large documents (500+ chunks), consider batching the embed call into groups of 100-200 chunks and posting them sequentially rather than one massive payload, with per-batch progress updates. Reduces peak memory pressure on Ollama and gives finer-grained progress.

- [ ] **RAG Collection Manager (filtering & re-indexing)**
  - Per-document re-indexing, embedding dimension mismatch checks on query (querying with a different model than was used to index), duplicate detection, and per-collection filters so chat RAG can target specific document sets rather than all indexed docs.

- [ ] **Memory Telemetry: Real Remote VRAM Monitoring**
  - Ollama's `/api/ps` exposes loaded model sizes but not total GPU VRAM capacity or utilization. The VRAM progress bars currently scale against the NEUROLLAMA host machine's RAM which is meaningless for remote servers.
  - Options to explore: (a) let users manually enter total VRAM per registered server so bars are meaningful, (b) add an optional companion lightweight agent on the remote host that exposes `nvidia-smi` stats via a tiny HTTP endpoint, (c) poll Ollama's `/api/version` for any future GPU stats endpoint they add.

- [ ] **Context Window: Model-Aware Validation**
  - The context selects now go up to 100M but have no awareness of what the selected model actually supports. Add a soft warning when the chosen context exceeds the model's `context_length` from its details (already available in model metadata). Prevents confusing silent failures when Ollama silently clamps the value.

- [x] **PDF.js: Self-Host Worker Instead of CDN**
  - Worker script is loaded from `cdnjs.cloudflare.com` at runtime. If the CDN is unreachable (airgapped installs, strict firewalls) PDF upload silently breaks. Vendor `pdf.worker.min.js` into `static/js/` and update the `workerSrc` path. The main `pdf.min.js` would also need to be vendored or loaded locally.

- [ ] **Cold-Start Timeout Audit**
  - Fixed the 10-second timeout for RAG embedding calls. Audit other operations that use `c.HTTPClient` directly (non-streaming model calls, unload, copy) and confirm they either already use a long client or are fast enough that 10s is safe. Model `copy` in particular can be slow for large models.

## Code Review Follow-Up

- [ ] **Local Auth & Safer Network Binding**
  - Add optional password/API-key protection for the web UI and API routes.
  - Make the bind host configurable and default local installs to `127.0.0.1` instead of listening on all interfaces.
  - Update Docker examples to publish `127.0.0.1:8080:8080` by default, with explicit reverse-proxy guidance for public deployments.

- [x] **Stored XSS Hardening Pass (partial — v0.2.20)**
  - Server registry cards, fleet node cards, scheduler logs, and telemetry active-model rows are now fully escaped via `escapeHTML()`.
  - Remaining exposure: optimizer tables, RAG document/query output, upload logs — still need a pass.
  - A safe-render helper (`escapeHTML`) already exists; usage needs to be audited across remaining `innerHTML` sites.

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
- [ ] **Bar chart view** — Add a "Chart" toggle above the leaderboard that replaces the table with an SVG or canvas bar chart comparing the primary metric (TPS / accuracy / cps) across all visible model groups. Same filter state as the table. Toggle back with "Table".

- [x] **Batch run mode** — "Run All" button on standard benchmarks queues all compatible models for the current type/size filter and runs them sequentially. Progress indicator shows `N/total · modelname`. Stop aborts the queue; errors skip to the next model.
