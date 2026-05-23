# NEUROLLAMA — Scale & Performance Roadmap

Tracking 16 items across 4 phases. Each phase ships as a patch version bump.
Current version: **v0.2.6**

> **Context:** With 10+ Ollama nodes and 100+ models per node, the current
> request-time fetching model breaks down. Every page load hits all nodes live,
> blocking the UI until the slowest responds. The fix is a server-side cache
> layer that background-polls all nodes; the frontend APIs become instant reads.

---

## Phase 1 — Core Performance → v0.2.4

Foundation. Everything in Phase 2–4 builds on the cache established here.

- [x] **1. Node status background cache** (`main.go`)
  - Add `nodeStatusCache map[string]ServerStatusResponse` + `nodeStatusMu sync.RWMutex`
  - One goroutine polls all configured nodes concurrently every 5s
  - `/api/servers` reads from cache — responds in <1ms regardless of node count
  - Cache is pre-warmed at startup before first request is served

- [x] **2. Model list background cache** (`main.go`)
  - Add `nodeModelCache map[string][]Model` + mutex
  - Background goroutine refreshes each node's model list every 60s
  - `/api/models` serves from cache instead of hitting Ollama live
  - Cache entry includes `lastUpdated time.Time` timestamp

- [x] **3. Cache invalidation hooks** (`main.go`)
  - Pull model → invalidate + immediately re-poll that node's model cache
  - Delete model → same
  - Add node → add to poller, seed cache entry
  - Edit node → update poller target, invalidate cache entry
  - Delete node → remove from poller, drop cache entry

- [x] **4. Tighter poller timeouts (E)** (`main.go`, `ollama.go`)
  - Give `CheckStatus()` calls inside background goroutines a 3s context deadline
  - Give `ListActiveModels()` (telemetry poller) a 3s context deadline
  - Slow/dead node stalls only its own goroutine, never blocks a UI request
  - Keep the existing 10s timeout for user-initiated operations (pull, chat, etc.)

- [x] **5. Lazy-load model inventory (C)** (`static/js/app.js`)
  - Remove `fetchModels()` from `init()`
  - Call it only when Inventory tab is first activated (`switchWorkspace('inventory')`)
  - Add a `modelsLoaded` flag so repeat tab visits don't re-fetch unnecessarily
  - All other landing tabs (Playground, Memory, Benchmarks) are unaffected

- [x] **6. Optimistic server render (A)** (`static/js/app.js`)
  - Stop `await`-ing `fetchServers()` before anything renders in `init()`
  - Render server configs + last-known status immediately on load
  - Live status updates arrive via SSE nodeStatus events (Phase 2, item 9)
  - In the interim (before Phase 2), a non-blocking background `fetchServers()` fills in status dots

---

## Phase 2 — Real-time Push → v0.2.5

Removes browser polling for node status; everything becomes event-driven.

- [x] **7. SSE nodeStatus events** (`main.go`)
  - Background status poller compares new result against cached result
  - On state change (online↔offline), push `nodeStatus` SSE event to all connected clients
  - Event payload: `{ id, status, latency, version }`
  - Reuse existing `/api/telemetry/stream` SSE connection — add new event type

- [x] **8. Manual node refresh endpoint** (`main.go`)
  - `POST /api/nodes/:id/refresh`
  - Drops the node's cache slot and triggers an immediate re-poll
  - Returns updated status once re-poll completes (or 3s timeout)

- [x] **9. Consume nodeStatus SSE events** (`static/js/app.js`)
  - Add `nodeStatus` event listener on the existing telemetry EventSource
  - Update status dot and latency for the relevant server card reactively
  - Remove the repeated `fetchServers()` calls scattered through CRUD handlers
    (add/edit/delete server currently re-fetch the full list)

- [x] **10. Stale-while-revalidate for model list** (`static/js/app.js`)
  - On Inventory tab activate: immediately render any list stored in `localStorage('model-cache')`
  - Fetch fresh list from `/api/models` (now fast — cache read) in background
  - Silently update the table and write new result to localStorage
  - Lower priority once server cache is in (item 2 already makes the API fast),
    but adds resilience for slow connections and returning users

---

## Phase 3 — Scale UX → v0.2.6

Handles 100+ models per node gracefully in the UI.

- [x] **11. Paginated `/api/models` endpoint** (`main.go`)
  - Add `?page=1&limit=50&node=<serverID>` query params
  - Server slices from the model cache
  - Response includes `{ models: [], total: N, page: N, limit: N }`
  - Default limit 50; max 200

- [x] **12. Cross-node model search endpoint** (`main.go`)
  - `GET /api/models/search?q=llama3&nodes=all`
  - Walks all `nodeModelCache` entries server-side
  - Returns matches with `node_id` and `node_name` fields on each model
  - Supports filtering by a comma-separated node ID list

- [x] **13. Inventory pagination controls** (`templates/index.html`, `static/js/app.js`)
  - Prev / Next page buttons + current page indicator
  - Page size selector (25 / 50 / 100)
  - Total model count displayed in panel header
  - Client-side pagination of the full models[] array (dropdowns stay complete)

- [x] **14. "Last refreshed" indicator + manual refresh button** (`templates/index.html`, `static/js/app.js`)
  - Each node card in the registry sidebar shows "updated Xs ago" from cache timestamp
  - Small refresh icon (↺) beside the timestamp hits the Phase 2 refresh endpoint (item 8)
  - Model inventory panel header also shows "last synced Xs ago" for the active node

---

## Phase 4 — Multi-node Features → v0.2.7

Fleet-level visibility and cross-node operations.

- [ ] **15. Node health overview panel** (`templates/index.html`, `static/js/app.js`, `main.go`)
  - New aggregate endpoint `GET /api/nodes/overview` — returns all nodes' cached status,
    loaded model count, VRAM in use, latency, Ollama version in one response
  - UI: grid/dashboard showing all nodes simultaneously (status, VRAM, loaded models)
  - Probably a new tab ("FLEET" or "OVERVIEW") or expands the Memory tab
  - Replaces the current "pick one active node" model with a full-fleet view

- [ ] **16. Cross-node model search UI** (`templates/index.html`, `static/js/app.js`)
  - Search bar in Inventory that hits the Phase 3 search endpoint (item 12)
  - Results grouped or badged by node
  - Surfaces "which of my nodes has gemma3:27b right now?" queries
  - Actions (delete, inspect) scoped to the owning node

---

## Version Map

| Version | Phase | Description |
|---------|-------|-------------|
| v0.2.3  | —     | lint/gosec clean, --help/--version, healthcheck |
| v0.2.4  | 1     | server-side cache, lazy-load, optimistic render |
| v0.2.5  | 2     | SSE node events, no-refetch CRUD, stale-while-revalidate |
| v0.2.6  | 3     | Current: pagination, cross-node search API, last-refreshed indicators |
| v0.2.7  | 4     | Multi-node: fleet overview, cross-node model search UI |
