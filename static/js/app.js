// State Management
let servers = [];
let models = [];
let selectedModels = new Set();
let inspectedModel = null;
let openAccordionModel = null;
let accordionEl = null;
let activeDetailTab = 'modelfile';
let currentEventSource = null;
let modelCardCache = null;
let modelCardViewMode = 'safe';

// New State for v0.0.2
let activeWorkspace = 'inventory';
let activeSystemSubtab    = 'settings';  // sub-tab active inside the System workspace
let activeInventorySubtab = 'models';    // sub-tab active inside the Inventory workspace
let modelsLoaded = false; // lazy-load guard — only fetch on first Inventory tab visit

// Inventory pagination (client-side)
let inventoryPage = 1;
let inventoryPageSize = 50;
let lastModelSyncTs = 0; // unix seconds from API lastUpdated field

// Server last-seen timestamps (ms) — updated on fetchServers and nodeStatus SSE events
const serverLastSeen = {};

// Cross-node model search
let crossNodeSearchQuery = '';
let crossNodeSearchTimer = null;
let chatMessages = [];
let isGeneratingChat = false;
let isBuildingModel = false;
let chatAbortController = null;
let buildAbortController = null;
let lastChatRetryDraft = null;

// New State for v0.0.3 SQLite Persistence & Presets
let chatSessions = [];
let activeChatId = null;
let presets = [];
let selectedImages = [];
let speedHistory = [];

// ── Searchable select combobox ──────────────────────────────────────────────
// Wraps a native <select> with a keyboard-searchable dropdown.
// The hidden <select> stays as the source of truth; all existing .value reads
// and 'change' event listeners on it continue to work unchanged.
function makeSearchableSelect(selectEl) {
  if (!selectEl || selectEl._ssInit) return null;
  selectEl._ssInit = true;

  const isXs = selectEl.classList.contains('select-xs');

  // Wrapper ---------------------------------------------------------------
  const wrapper = document.createElement('div');
  wrapper.className = 'ss-wrapper';
  selectEl.parentNode.insertBefore(wrapper, selectEl);
  wrapper.appendChild(selectEl);
  selectEl.style.display = 'none';

  // Trigger ---------------------------------------------------------------
  const trigger = document.createElement('div');
  trigger.className = 'ss-trigger' + (isXs ? ' xs' : '');
  trigger.tabIndex = 0;
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const triggerText = document.createElement('span');
  triggerText.className = 'ss-trigger-text';

  const chevron = document.createElement('span');
  chevron.className = 'ss-chevron';
  chevron.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';

  trigger.appendChild(triggerText);
  trigger.appendChild(chevron);
  wrapper.appendChild(trigger);

  // Panel -----------------------------------------------------------------
  const panel = document.createElement('div');
  panel.className = 'ss-panel';
  panel.setAttribute('role', 'listbox');

  const searchWrap = document.createElement('div');
  searchWrap.className = 'ss-search-wrap';

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'ss-search';
  searchInput.placeholder = 'Type to filter…';
  searchInput.setAttribute('autocomplete', 'off');
  searchInput.setAttribute('spellcheck', 'false');
  searchWrap.appendChild(searchInput);
  panel.appendChild(searchWrap);

  const optList = document.createElement('ul');
  optList.className = 'ss-list';
  panel.appendChild(optList);
  wrapper.appendChild(panel);

  let isOpen = false;
  let activeIdx = -1;

  function renderOptions(filter) {
    optList.innerHTML = '';
    activeIdx = -1;
    const f = (filter || '').toLowerCase().trim();
    const all = Array.from(selectEl.options);
    const visible = f ? all.filter(o => o.text.toLowerCase().includes(f) || o.value.toLowerCase().includes(f)) : all;

    if (visible.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'ss-empty';
      empty.textContent = 'No matches';
      optList.appendChild(empty);
      return;
    }

    visible.forEach(opt => {
      const li = document.createElement('li');
      const isSel = opt.value === selectEl.value;
      li.className = 'ss-option' + (isSel ? ' ss-selected' : '');
      li.dataset.value = opt.value;
      li.title = opt.text; // full text tooltip on hover
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', isSel ? 'true' : 'false');

      // Split "modelname (paramSize)" → name + param badge
      const paramMatch = opt.text.match(/^(.+?)\s*\((.+?)\)$/);
      const dispName  = paramMatch ? paramMatch[1] : opt.text;
      const paramSize = paramMatch && paramMatch[2] !== '?' ? paramMatch[2] : '';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'ss-opt-name';
      nameSpan.textContent = dispName;
      li.appendChild(nameSpan);

      if (paramSize) {
        const paramSpan = document.createElement('span');
        paramSpan.className = 'ss-opt-param';
        paramSpan.textContent = paramSize;
        li.appendChild(paramSpan);
      }

      li.addEventListener('mousedown', e => {
        e.preventDefault();
        selectEl.value = opt.value;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        updateTrigger();
        close();
      });
      optList.appendChild(li);
    });
  }

  function setActiveItem(idx) {
    const items = optList.querySelectorAll('.ss-option');
    items.forEach((el, i) => el.classList.toggle('ss-active', i === idx));
    if (idx >= 0 && idx < items.length) items[idx].scrollIntoView({ block: 'nearest' });
    activeIdx = idx;
  }

  function updateTrigger() {
    const idx = selectEl.selectedIndex;
    const opt = idx >= 0 ? selectEl.options[idx] : null;
    const fullText = (opt && opt.text) ? opt.text : '---';
    // Show "name (param)" in trigger but strip param from display if it fits better
    const paramMatch = fullText.match(/^(.+?)\s*\((.+?)\)$/);
    const dispText  = paramMatch ? paramMatch[1] : fullText;
    const paramHint = paramMatch && paramMatch[2] !== '?' ? ` (${paramMatch[2]})` : '';
    triggerText.textContent = dispText;
    trigger.title = fullText; // tooltip on the whole trigger for full name + param
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    panel.classList.add('open');
    trigger.classList.add('open');
    chevron.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    searchInput.value = '';
    renderOptions('');
    const sel = optList.querySelector('.ss-selected');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
    requestAnimationFrame(() => searchInput.focus());
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    panel.classList.remove('open');
    trigger.classList.remove('open');
    chevron.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
    activeIdx = -1;
  }

  // Events ----------------------------------------------------------------
  trigger.addEventListener('click', () => isOpen ? close() : open());
  trigger.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); open(); }
  });

  searchInput.addEventListener('input', () => renderOptions(searchInput.value));
  searchInput.addEventListener('keydown', e => {
    const items = optList.querySelectorAll('.ss-option');
    if (e.key === 'Escape') { close(); trigger.focus(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveItem(Math.min(activeIdx + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveItem(Math.max(activeIdx - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIdx >= 0 && activeIdx < items.length) items[activeIdx].dispatchEvent(new MouseEvent('mousedown'));
      else if (items.length === 1) items[0].dispatchEvent(new MouseEvent('mousedown'));
    }
  });

  document.addEventListener('click', e => { if (isOpen && !wrapper.contains(e.target)) close(); });

  // Keep display in sync when native value or options change ---------------
  selectEl.addEventListener('change', () => { updateTrigger(); if (isOpen) renderOptions(searchInput.value); });

  // MutationObserver: fires when innerHTML is replaced (populateModelDropdowns)
  // Defer one tick so the .value = assignment that follows innerHTML= can run first.
  new MutationObserver(() => setTimeout(updateTrigger, 0)).observe(selectEl, { childList: true });

  updateTrigger();

  return { open, close, refresh() { updateTrigger(); if (isOpen) renderOptions(searchInput.value); } };
}
// ── End searchable select ────────────────────────────────────────────────────

// ── Preferences (DB-backed, loaded once at startup) ───────────────────────────
let prefs = {};

async function loadPreferences() {
  try {
    const res = await fetch('/api/preferences');
    if (res.ok) prefs = await res.json();
  } catch { /* offline — fall back to defaults */ }
}

// getPref reads from the in-memory prefs map, returning defaultValue if absent.
function getPref(key, defaultValue = '') {
  return (key in prefs) ? prefs[key] : defaultValue;
}

// setPref optimistically updates the local map and fire-and-forgets a PUT.
function setPref(key, val) {
  prefs[key] = String(val);
  fetch('/api/preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value: String(val) }),
  }).catch(() => {});
}
// ── End preferences helpers ──────────────────────────────────────────────────

// Initialization
document.addEventListener('DOMContentLoaded', () => {
  init();
  // Close node slide-out when clicking outside of it or its trigger button
  document.addEventListener('click', e => {
    const panel  = document.getElementById('node-slideout');
    const btn    = document.getElementById('footer-node-btn');
    if (!panel || panel.classList.contains('hidden')) return;
    if (!panel.contains(e.target) && !btn?.contains(e.target)) closeNodeSlideout();
  });
});

async function init() {
  // Load all user preferences from DB before restoring any state.
  await loadPreferences();

  initAccordionRow();
  // Non-blocking: fire and forget — page renders immediately, server cards and
  // status dots fill in once the (now-instant) cache read completes.
  fetchServers();
  // Initialize catalog view (does not need server data)
  renderCatalog();
  // Restore failure badge from localStorage on load
  updateFailureBadge();

  // Add system prompt input listener
  const sysTextarea = document.getElementById('chat-system-prompt');
  if (sysTextarea) {
    sysTextarea.addEventListener('input', (e) => {
      updatePresetDropdownSelection(e.target.value);
      updateContextVisualizer();
    });
  }

  // Bind change event listeners to auto-save playground parameters
  const playgroundConfigIds = [
    'chat-model-select',
    'chat-system-prompt',
    'chat-temp',
    'chat-ctx-limit',
    'chat-top-k',
    'chat-top-p',
    'chat-repeat-penalty',
    'chat-seed',
    'chat-min-p',
    'chat-presence-penalty',
    'chat-frequency-penalty',
    'chat-num-predict',
    'chat-num-gpu',
    'chat-num-thread',
    'chat-rag-enabled',
    'chat-rag-model-select',
    'chat-rag-top-k'
  ];
  playgroundConfigIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', () => {
        if (activeChatId) {
          updateActiveChatConfig();
        }
        updateContextVisualizer();
      });
      if (el.type === 'range' || el.type === 'checkbox') {
        el.addEventListener('input', () => {
          if (activeChatId) {
            updateActiveChatConfig();
          }
          updateContextVisualizer();
        });
      }
    }
  });

  // Initialize RAG chat sidebar controls
  const chatRagEnabledEl = document.getElementById('chat-rag-enabled');
  const chatRagModelContainer = document.getElementById('chat-rag-model-container');
  const chatRagTopKContainer = document.getElementById('chat-rag-top-k-container');
  
  function updateChatRAGControlsState() {
    if (!chatRagEnabledEl) return;
    const enabled = chatRagEnabledEl.checked;
    
    setPref('chat-rag-enabled', enabled);
    
    if (chatRagModelContainer) {
      if (enabled) {
        chatRagModelContainer.classList.remove('opacity-50', 'pointer-events-none');
        const select = chatRagModelContainer.querySelector('select');
        if (select) select.disabled = false;
      } else {
        chatRagModelContainer.classList.add('opacity-50', 'pointer-events-none');
        const select = chatRagModelContainer.querySelector('select');
        if (select) select.disabled = true;
      }
    }
    if (chatRagTopKContainer) {
      if (enabled) {
        chatRagTopKContainer.classList.remove('opacity-50', 'pointer-events-none');
        const range = chatRagTopKContainer.querySelector('input');
        if (range) range.disabled = false;
      } else {
        chatRagTopKContainer.classList.add('opacity-50', 'pointer-events-none');
        const range = chatRagTopKContainer.querySelector('input');
        if (range) range.disabled = true;
      }
    }
  }

  if (chatRagEnabledEl) {
    chatRagEnabledEl.addEventListener('change', updateChatRAGControlsState);
    
    const savedRagEnabled = getPref('chat-rag-enabled') === 'true';
    chatRagEnabledEl.checked = savedRagEnabled;

    const savedRagModel = getPref('chat-rag-model-select');
    const chatRagSelect = document.getElementById('chat-rag-model-select');
    if (savedRagModel && chatRagSelect) {
      chatRagSelect.value = savedRagModel;
    }

    const savedRagTopK = getPref('chat-rag-top-k');
    const chatRagTopKVal = document.getElementById('chat-rag-top-k');
    if (savedRagTopK && chatRagTopKVal) {
      chatRagTopKVal.value = savedRagTopK;
      const valDisp = document.getElementById('chat-rag-top-k-value');
      if (valDisp) valDisp.textContent = savedRagTopK;
    }

    updateChatRAGControlsState();
  }

  const chatRagSelectEl = document.getElementById('chat-rag-model-select');
  if (chatRagSelectEl) {
    chatRagSelectEl.addEventListener('change', () => {
      setPref('chat-rag-model-select', chatRagSelectEl.value);
    });
  }

  const chatRagTopKRange = document.getElementById('chat-rag-top-k');
  if (chatRagTopKRange) {
    chatRagTopKRange.addEventListener('change', () => {
      setPref('chat-rag-top-k', chatRagTopKRange.value);
    });
  }

  // Persist model dropdown selections across page loads
  [
    ['chat-model-select',       'neurollama-chat-model'],
    ['completion-model-select', 'neurollama-completion-model'],
    ['builder-base-select',     'neurollama-builder-model'],
    ['benchmark-model-select',  'neurollama-bench-model'],
    ['optimizer-model-select',  'neurollama-optimizer-model'],
    ['rag-model-select',        'neurollama-rag-model'],
  ].forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => setPref(key, el.value));
  });

  // Initialize RAG drag-and-drop & file input listeners
  const dragZone = document.getElementById('rag-drag-zone');
  const fileInput = document.getElementById('rag-file-input');

  if (dragZone && fileInput) {
    dragZone.addEventListener('click', () => fileInput.click());

    dragZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dragZone.classList.add('border-[#88c0d0]', 'bg-[#2e3440]/60');
    });

    dragZone.addEventListener('dragleave', () => {
      dragZone.classList.remove('border-[#88c0d0]', 'bg-[#2e3440]/60');
    });

    dragZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dragZone.classList.remove('border-[#88c0d0]', 'bg-[#2e3440]/60');
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleRAGUpload(e.dataTransfer.files[0]);
      }
    });

    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        handleRAGUpload(e.target.files[0]);
      }
    });
  }

  // Initialize collapsible sidebars state
  initSidebarState();

  // Load Completion workspace configurations
  loadCompletionSettings();

  // Bind change/input event listeners to auto-save completion parameters
  const completionConfigIdsList = [
    'completion-model-select',
    'completion-system-prompt',
    'completion-temp',
    'completion-ctx-limit',
    'completion-top-k',
    'completion-top-p',
    'completion-repeat-penalty',
    'completion-num-predict',
    'completion-num-gpu',
    'completion-num-thread',
    'completion-prompt-text',
    'completion-document-text'
  ];
  completionConfigIdsList.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', saveCompletionSettings);
      el.addEventListener('change', saveCompletionSettings);
    }
  });

  // Bind paste event for images on chat input
  const chatInputText = document.getElementById('chat-input-text');
  if (chatInputText) {
    chatInputText.addEventListener('paste', function(e) {
      const items = (e.clipboardData || e.originalEvent.clipboardData).items;
      let hasImage = false;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const file = items[i].getAsFile();
          handleChatImageFiles([file]);
          hasImage = true;
        }
      }
      if (hasImage) {
        e.preventDefault();
      }
    });
  }

  // Wire up prompt history navigation (↑/↓) on chat and completion inputs
  initPromptHistory('chat-input-text');
  initPromptHistory('completion-prompt-text');

  // Start background telemetry stream
  startTelemetrySSE();

  // Tick every 30s to keep "Xs ago" timestamps fresh without extra requests
  setInterval(() => {
    if (servers.length > 0) renderServers();
    updateInventorySyncBadge();
  }, 30000);

  // Pre-seed models from stale cache so dropdowns are populated on any first-visit workspace.
  // (The full stale-while-revalidate renderModels() still runs inside switchWorkspace('inventory').)
  try {
    const cachedRaw = localStorage.getItem('neurollama-model-cache');
    if (cachedRaw) {
      const { models: cachedModels } = JSON.parse(cachedRaw);
      if (Array.isArray(cachedModels) && cachedModels.length > 0) {
        models = cachedModels;
      }
    }
  } catch { /* corrupt cache — ignore */ }

  // Restore inventory + system sub-tabs
  activeInventorySubtab = getPref('neurollama-inventory-subtab', 'models');
  // Restore system sub-tab, then handle legacy workspace values
  // (old saves of 'memory' / 'diagnostics' / 'settings' redirect to 'system')
  activeSystemSubtab = getPref('neurollama-system-subtab', 'settings');
  let savedWorkspace = getPref('active-workspace', 'inventory');
  // Restore leaderboard sort state
  lbSortCol = getPref('neurollama-bench-sort-col', 'created_at');
  lbSortDir = getPref('neurollama-bench-sort-dir', 'desc');
  const legacySystemTabs = { memory: 'memory', diagnostics: 'diagnostics', settings: 'settings' };
  if (legacySystemTabs[savedWorkspace]) {
    activeSystemSubtab = legacySystemTabs[savedWorkspace];
    savedWorkspace = 'system';
  }
  // Attach searchable combobox to every model dropdown
  [
    'chat-model-select',
    'chat-rag-model-select',
    'completion-model-select',
    'builder-base-select',
    'benchmark-model-select',
    'optimizer-model-select',
    'rag-model-select',
  ].forEach(id => {
    const el = document.getElementById(id);
    if (el) makeSearchableSelect(el);
  });

  switchWorkspace(savedWorkspace);
}

// --- WORKSPACE & TAB SWITCHING ---
function switchWorkspace(workspace) {
  if (isGeneratingChat) {
    showToast('A chat stream is in progress. Please wait.', 'warning');
    return;
  }
  if (isGeneratingCompletion) {
    showToast('A completion generation is in progress. Please wait.', 'warning');
    return;
  }
  if (isBuildingModel) {
    showToast('A model compilation is in progress.', 'warning');
    return;
  }

  // Always hide system sub-panels before switching (prevents bleed when leaving system workspace)
  stopActivityPoll();
  ['memory', 'diagnostics', 'settings', 'activity', 'about', 'data'].forEach(sp => {
    const p = document.getElementById(`ws-panel-${sp}`);
    if (p) p.classList.add('hidden');
  });

  // Toggle top-level tab buttons and panels
  const tabs = ['inventory', 'playground', 'completion', 'builder', 'benchmark', 'rag', 'system', 'fleet'];
  tabs.forEach(t => {
    const btn = document.getElementById(`ws-tab-${t}`);
    const panel = document.getElementById(`ws-panel-${t}`);
    if (btn) btn.classList.toggle('tab-active', t === workspace);
    if (panel) panel.classList.toggle('hidden', t !== workspace);
  });

  activeWorkspace = workspace;
  setPref('active-workspace', workspace);

  // Tab specific actions
  if (workspace === 'inventory') {
    // Restore the last-used inventory sub-tab (models or hub)
    switchInventorySubtab(activeInventorySubtab);

    // Always clear any lingering cross-node search results so the inventory
    // shows only the currently active node's models.
    if (crossNodeSearchQuery) clearCrossNodeSearch(true);

    if (!modelsLoaded) {
      // Show any stale data from localStorage immediately while fresh data loads.
      try {
        const cachedRaw = localStorage.getItem('neurollama-model-cache');
        if (cachedRaw) {
          const { models: cachedModels } = JSON.parse(cachedRaw);
          if (Array.isArray(cachedModels) && cachedModels.length > 0) {
            models = cachedModels;
            renderModels();
          }
        }
      } catch { /* corrupt cache — ignore */ }
      // Fetch fresh from server-side cache (instant) then update the table.
      fetchModels();
    } else {
      // Models already loaded — re-render to flush any stale DOM state
      // (e.g. cross-node search results that were just cleared above).
      renderModels();
    }
  } else if (workspace === 'system') {
    switchSystemSubtab(activeSystemSubtab);
  } else if (workspace === 'benchmark') {
    populateModelDropdowns();
    restoreLbFilterUI();
    fetchBenchmarks();
  } else if (workspace === 'playground') {
    populateModelDropdowns();
    fetchPresets();
    fetchSavedChats();
  } else if (workspace === 'completion') {
    populateModelDropdowns();
  } else if (workspace === 'builder') {
    populateModelDropdowns();
    generateModelfilePreview();
  } else if (workspace === 'rag') {
    populateModelDropdowns();
    loadRAGDocuments();
  } else if (workspace === 'fleet') {
    fetchFleetOverview();
  }
}

function switchInventorySubtab(tab) {
  activeInventorySubtab = tab;
  setPref('neurollama-inventory-subtab', tab);
  ['models', 'hub'].forEach(t => {
    const btn = document.getElementById(`inventory-subtab-${t}`);
    const container = document.getElementById(`inventory-${t}-container`);
    if (btn) btn.classList.toggle('bench-subtab-active', t === tab);
    if (container) container.classList.toggle('hidden', t !== tab);
  });
  // Ensure catalog renders and HF note state is synced when hub is opened
  if (tab === 'hub') {
    renderCatalog();
    const hfNote = document.getElementById('hf-compat-note');
    if (hfNote) hfNote.classList.toggle('hidden', currentPullSource !== 'hf');
  }
}

function switchSystemSubtab(subtab) {
  activeSystemSubtab = subtab;
  setPref('neurollama-system-subtab', subtab);

  // Show/hide sub-panels and toggle active state on sub-tab buttons
  ['memory', 'diagnostics', 'settings', 'activity', 'about', 'data'].forEach(sp => {
    const panel = document.getElementById(`ws-panel-${sp}`);
    if (panel) panel.classList.toggle('hidden', sp !== subtab);
    const btn = document.getElementById(`system-subtab-${sp}`);
    if (btn) btn.classList.toggle('bench-subtab-active', sp === subtab);
  });

  // Fire init actions for the newly active sub-tab
  if (subtab === 'memory') {
    fetchActiveModels();
  } else if (subtab === 'settings') {
    fetchSchedulerSettings();
    fetchSchedulerLogs();
  } else if (subtab === 'diagnostics') {
    runDiagnostics();
    renderStreamFailureLog();
  } else if (subtab === 'activity') {
    startActivityPoll();
  } else if (subtab === 'about') {
    stopActivityPoll();
    fetchAbout();
  } else if (subtab === 'data') {
    stopActivityPoll();
    refreshDataPanel();
  } else {
    stopActivityPoll();
  }
}

// ── System: About ────────────────────────────────────────────────────────────

async function fetchAbout() {
  const grid = document.getElementById('about-grid');
  if (!grid) return;
  grid.innerHTML = '<div class="col-span-full text-[#4c566a] animate-pulse font-mono text-xs">Loading…</div>';
  try {
    const res = await fetch('/api/about');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    const row = (label, value) =>
      `<div class="flex flex-col gap-0.5">
         <div class="text-[#4c566a] text-[10px] tracking-wider uppercase">${label}</div>
         <div class="text-[#d8dee9]">${value}</div>
       </div>`;
    grid.innerHTML =
      row('Version',        d.version) +
      row('Go Runtime',     d.goVersion) +
      row('Uptime',         d.uptime) +
      row('Started',        d.startTime) +
      row('Database',       `<span class="text-[#81a1c1]">${d.dbPath}</span>`) +
      row('DB Size',        `<span class="text-[#88c0d0]">${d.dbSize || '—'}</span>${d.dbSizeWal && d.dbSizeWal !== '0 B' ? ` <span class="text-[#4c566a] text-[9px]">+ ${d.dbSizeWal} WAL</span>` : ''}`) +
      row('Chat Sessions',  d.chatCount) +
      row('Benchmark Runs', d.benchCount);
    // Keep Data panel counters in sync if they're visible
    _updateDataPanelCounts(d.chatCount, d.benchCount);
    // Render Ollama release note tiles
    renderOllamaReleaseTiles();
  } catch (e) {
    grid.innerHTML = `<div class="col-span-full text-[#bf616a] font-mono text-xs">Failed to load app info: ${e.message}</div>`;
  }
}

// ── Ollama Release Notes ──────────────────────────────────────────────────────

// Inline markdown → safe HTML for text nodes within a line.
function _inlineMd(raw) {
  // 1. HTML-escape the raw text
  let s = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // 2. [text](url) links
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener" class="text-[#88c0d0] hover:underline">$1</a>');
  // 3. **bold**
  s = s.replace(/\*\*([^*]+)\*\*/g,
    '<strong class="text-[#e5e9f0] font-semibold">$1</strong>');
  // 4. `code`
  s = s.replace(/`([^`]+)`/g,
    '<code class="bg-[#2e3440] text-[#a3be8c] px-1 rounded text-[9px] font-mono">$1</code>');
  return s;
}

// Convert a GitHub-flavoured markdown string to styled HTML.
function renderOllamaMd(md) {
  if (!md) return '<em class="text-[#4c566a]">No content.</em>';
  const lines = md.split('\n');
  let html = '';
  let inUl = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const isBullet = /^[-*]\s+/.test(line);

    if (!isBullet && inUl) { html += '</ul>'; inUl = false; }

    if (/^##\s+/.test(line)) {
      html += `<p class="text-[#81a1c1] font-tech text-[10px] uppercase tracking-widest mt-3 mb-1 font-semibold">${_inlineMd(line.replace(/^#+\s+/, ''))}</p>`;
    } else if (/^###/.test(line)) {
      html += `<p class="text-[#88c0d0] font-tech text-[10px] uppercase tracking-wider mt-2 mb-0.5">${_inlineMd(line.replace(/^#+\s+/, ''))}</p>`;
    } else if (isBullet) {
      if (!inUl) { html += '<ul class="list-none space-y-0.5 my-1">'; inUl = true; }
      html += `<li class="flex gap-1.5"><span class="text-[#4c566a] shrink-0">›</span><span class="text-[#d8dee9]">${_inlineMd(line.replace(/^[-*]\s+/, ''))}</span></li>`;
    } else if (line === '') {
      html += '<div class="h-1.5"></div>';
    } else {
      html += `<p class="text-[#d8dee9]">${_inlineMd(line)}</p>`;
    }
  }
  if (inUl) html += '</ul>';
  return html;
}

async function renderOllamaReleaseTiles() {
  const container = document.getElementById('ollama-release-tiles');
  if (!container) return;
  container.innerHTML = '<div class="text-[#4c566a] font-mono text-[10px] animate-pulse py-1">Fetching release notes…</div>';

  // Active node version
  const active = servers.find(s => s.isActive);
  const runningVer = active?.status === 'online' ? active.version : null;

  // Ensure we have latest stable/pre info
  if (!ollamaLatestInfo) {
    try {
      const r = await fetch('/api/ollama-latest');
      if (r.ok) {
        const d = await r.json();
        ollamaLatestInfo = { stable: d.stable || '', prerelease: d.prerelease || '', fetchedAt: Date.now() };
      }
    } catch {}
  }

  const stable    = ollamaLatestInfo?.stable    || '';
  const prerelease = ollamaLatestInfo?.prerelease || '';

  // Decide which tiles to render
  const tiles = [];

  if (runningVer) {
    tiles.push({ version: runningVer, label: 'RUNNING', kind: 'running' });
  }

  // Latest stable — show whenever it differs from running
  if (stable && stable !== runningVer) {
    tiles.push({ version: stable, label: 'LATEST STABLE', kind: 'stable' });
  }

  // Pre-release — show if it's newer than stable AND different from what's running
  if (prerelease && compareVersions(prerelease, stable) > 0 && prerelease !== runningVer) {
    tiles.push({ version: prerelease, label: 'PRE-RELEASE', kind: 'prerelease' });
  }

  if (tiles.length === 0) { container.innerHTML = ''; return; }

  // Fetch all in parallel
  const results = await Promise.all(tiles.map(async t => {
    try {
      const r = await fetch(`/api/ollama-release-notes?version=${encodeURIComponent(t.version)}`);
      if (r.status === 404) return { ...t, body: null, url: null };
      if (!r.ok) return { ...t, body: null, url: null };
      const d = await r.json();
      return { ...t, body: d.body || null, url: d.html_url || null };
    } catch { return { ...t, body: null, url: null }; }
  }));

  const badgeCls = {
    running:    'bg-[#a3be8c]/15 text-[#a3be8c] border border-[#a3be8c]/40',
    stable:     'bg-[#ebcb8b]/15 text-[#ebcb8b] border border-[#ebcb8b]/30',
    prerelease: 'bg-[#88c0d0]/15 text-[#88c0d0] border border-[#88c0d0]/30',
  };
  const colCls = results.length === 1 ? '' : results.length === 2 ? 'xl:grid-cols-2' : 'xl:grid-cols-3';

  container.innerHTML = `
    <div class="grid grid-cols-1 ${colCls} gap-4">
      ${results.map(t => `
        <div class="tech-panel rounded-xl p-4 flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <span class="px-2 py-0.5 rounded text-[9px] font-tech tracking-wide ${badgeCls[t.kind]}">${t.label}</span>
              <span class="font-mono text-[#d8dee9] text-xs font-semibold">v${escapeHTML(t.version)}</span>
            </div>
            ${t.url ? `<a href="${escapeHTML(t.url)}" target="_blank" rel="noopener"
              class="flex items-center gap-1 text-[#4c566a] hover:text-[#88c0d0] transition-colors text-[10px] font-mono shrink-0">
              <i class="fa-brands fa-github text-[9px]"></i>GitHub
            </a>` : ''}
          </div>
          <div class="overflow-y-auto max-h-72 font-mono text-[10px] leading-relaxed space-y-0.5 pr-1">
            ${t.body ? renderOllamaMd(t.body) : '<em class="text-[#4c566a]">No release notes found.</em>'}
          </div>
        </div>`).join('')}
    </div>`;
}

// ── System: Data Management ──────────────────────────────────────────────────

function _updateDataPanelCounts(chatCount, benchCount) {
  const chatDesc = document.getElementById('db-chat-desc');
  if (chatDesc && chatCount !== undefined)
    chatDesc.textContent = `${chatCount} session${chatCount !== 1 ? 's' : ''}`;
  const benchDesc = document.getElementById('db-bench-desc');
  if (benchDesc && benchCount !== undefined)
    benchDesc.textContent = `${benchCount} run${benchCount !== 1 ? 's' : ''}`;
}

function refreshDataPanel() {
  // Update model cache description from localStorage
  const cacheDesc = document.getElementById('cache-model-desc');
  if (cacheDesc) {
    try {
      const raw = localStorage.getItem('neurollama-model-cache');
      if (raw) {
        const { models: m, ts } = JSON.parse(raw);
        const ageMins = Math.round((Date.now() - ts) / 60000);
        cacheDesc.textContent = `${m.length} model${m.length !== 1 ? 's' : ''} · cached ${ageMins}m ago`;
      } else {
        cacheDesc.textContent = 'No cache present';
      }
    } catch {
      cacheDesc.textContent = 'Cache unreadable';
    }
  }
  // Fetch live counts from API (also populates About grid if open)
  fetchAbout();
}

function clearModelCache() {
  localStorage.removeItem('neurollama-model-cache');
  showToast('Model cache cleared.', 'success');
  refreshDataPanel();
}

async function clearPreferences() {
  try {
    const res = await fetch('/api/preferences', { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    prefs = {};
    showToast('Preferences cleared. Refresh to apply.', 'success');
  } catch (e) {
    showToast('Failed to clear preferences: ' + e.message, 'error');
  }
}

function wipeAllLocalStorage() {
  if (!confirm('Clear ALL NEUROLLAMA local data from this browser? This cannot be undone.')) return;
  // Clear DB-backed preferences
  fetch('/api/preferences', { method: 'DELETE' }).catch(() => {});
  prefs = {};
  // Clear remaining browser-local ephemeral data (model cache, prompt history, stream failures)
  Object.keys(localStorage)
    .filter(k => k.startsWith('neurollama-') || k === 'active-workspace' || k.startsWith('sidebar-'))
    .forEach(k => localStorage.removeItem(k));
  showToast('All local data wiped. Reloading…', 'warning');
  setTimeout(() => location.reload(), 1200);
}

async function clearAllChats() {
  if (!confirm('Delete ALL chat history? This cannot be undone.')) return;
  try {
    const res = await fetch('/api/chats', { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    showToast('All chat history deleted.', 'success');
    fetchSavedChats(); // refresh sidebar history list
    refreshDataPanel();
  } catch (e) {
    showToast('Failed to delete chats: ' + e.message, 'error');
  }
}

async function clearAllBenchmarks() {
  if (!confirm('Delete ALL benchmark results? This cannot be undone.')) return;
  try {
    const res = await fetch('/api/benchmarks', { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    showToast('All benchmark results deleted.', 'success');
    fetchBenchmarks(); // refresh leaderboard
    refreshDataPanel();
  } catch (e) {
    showToast('Failed to delete benchmarks: ' + e.message, 'error');
  }
}

// ── System: Backup & Restore ─────────────────────────────────────────────────

function downloadBackup() {
  window.location.href = '/api/backup';
}

async function uploadRestore() {
  const input = document.getElementById('restore-file-input');
  const statusEl = document.getElementById('restore-status');
  if (!input || !input.files.length) {
    showToast('Select a .db file first.', 'warning');
    return;
  }
  const file = input.files[0];
  if (!confirm(`Restore from "${file.name}"?\n\nThe application must be restarted to apply the restore. Current data will be replaced.`)) return;

  const formData = new FormData();
  formData.append('file', file);

  if (statusEl) {
    statusEl.className = 'mt-2 font-mono text-[10px] text-[#ebcb8b]';
    statusEl.textContent = 'Uploading…';
  }

  try {
    const res = await fetch('/api/restore', { method: 'POST', body: formData });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Upload failed');
    if (statusEl) {
      statusEl.className = 'mt-2 font-mono text-[10px] text-[#a3be8c]';
      statusEl.textContent = '✓ ' + d.message;
    }
    showToast('Restore pending — restart NEUROLLAMA to apply.', 'success');
  } catch (e) {
    if (statusEl) {
      statusEl.className = 'mt-2 font-mono text-[10px] text-[#bf616a]';
      statusEl.textContent = '✗ ' + e.message;
    }
    showToast('Restore failed: ' + e.message, 'error');
  }
}

// ── Activity Log ─────────────────────────────────────────────────────────────

let activityPollInterval = null;

const ACTIVITY_CATEGORY_STYLE = {
  pull:      { bg: 'bg-[#88c0d0]/15', text: 'text-[#88c0d0]',  label: 'PULL'      },
  build:     { bg: 'bg-[#a3be8c]/15', text: 'text-[#a3be8c]',  label: 'BUILD'     },
  model:     { bg: 'bg-[#81a1c1]/15', text: 'text-[#81a1c1]',  label: 'MODEL'     },
  node:      { bg: 'bg-[#b48ead]/15', text: 'text-[#b48ead]',  label: 'NODE'      },
  benchmark: { bg: 'bg-[#ebcb8b]/15', text: 'text-[#ebcb8b]',  label: 'BENCH'     },
  system:    { bg: 'bg-[#4c566a]/30', text: 'text-[#d8dee9]',   label: 'SYSTEM'    },
};

function startActivityPoll() {
  fetchActivity();
  if (!activityPollInterval) {
    activityPollInterval = setInterval(fetchActivity, 5000);
  }
}

function stopActivityPoll() {
  if (activityPollInterval) {
    clearInterval(activityPollInterval);
    activityPollInterval = null;
  }
}

async function fetchActivity() {
  try {
    const res = await fetch('/api/activity');
    if (!res.ok) return;
    const entries = await res.json();
    renderActivityLog(entries);
  } catch { /* silent — poll will retry */ }
}

function renderActivityLog(entries) {
  const list = document.getElementById('activity-log-list');
  const countEl = document.getElementById('activity-count');
  if (!list) return;

  if (countEl) countEl.textContent = entries.length ? `(${entries.length})` : '';

  if (!entries.length) {
    list.innerHTML = '<div class="px-4 py-6 text-center text-[#4c566a] text-[11px]">No activity yet. Events will appear here as you use the app.</div>';
    return;
  }

  list.innerHTML = entries.map(e => {
    const style = ACTIVITY_CATEGORY_STYLE[e.category] || ACTIVITY_CATEGORY_STYLE.system;
    return `
      <div class="flex items-start gap-3 px-4 py-2.5 hover:bg-[#2e3440]/40 transition-colors">
        <span class="font-mono text-[10px] text-[#4c566a] shrink-0 pt-px w-16">${e.time}</span>
        <span class="shrink-0 inline-block px-1.5 py-0.5 rounded text-[9px] font-mono font-bold tracking-wider ${style.bg} ${style.text}">${style.label}</span>
        <span class="font-mono text-[11px] text-[#d8dee9] leading-relaxed">${escapeHTML(e.message)}</span>
      </div>`;
  }).join('');
}

function clearActivityDisplay() {
  const list = document.getElementById('activity-log-list');
  const countEl = document.getElementById('activity-count');
  if (list) list.innerHTML = '<div class="px-4 py-6 text-center text-[#4c566a] text-[11px]">Display cleared. New events will appear as they occur.</div>';
  if (countEl) countEl.textContent = '';
  stopActivityPoll();
}

// ── Prompt History (↑/↓ navigation) ─────────────────────────────────────────

let promptHistory = JSON.parse(localStorage.getItem('neurollama-prompt-history') || '[]');
let promptHistoryIndex = -1;
let promptDraft = '';

function addToPromptHistory(text) {
  if (!text.trim()) return;
  promptHistory = promptHistory.filter(p => p !== text);
  promptHistory.unshift(text);
  if (promptHistory.length > 50) promptHistory = promptHistory.slice(0, 50);
  localStorage.setItem('neurollama-prompt-history', JSON.stringify(promptHistory));
  promptHistoryIndex = -1;
  promptDraft = '';
}

function initPromptHistory(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' && !e.shiftKey) {
      const canEnter = input.value.trim() === '' || (input.selectionStart === 0 && input.selectionEnd === 0);
      if (promptHistoryIndex === -1 && !canEnter) return;
      e.preventDefault();
      if (promptHistoryIndex === -1) {
        promptDraft = input.value;
        if (!promptHistory.length) return;
        promptHistoryIndex = 0;
      } else if (promptHistoryIndex < promptHistory.length - 1) {
        promptHistoryIndex++;
      }
      input.value = promptHistory[promptHistoryIndex];
      input.setSelectionRange(0, 0);
    } else if (e.key === 'ArrowDown' && !e.shiftKey && promptHistoryIndex !== -1) {
      e.preventDefault();
      if (promptHistoryIndex > 0) {
        promptHistoryIndex--;
        input.value = promptHistory[promptHistoryIndex];
      } else {
        promptHistoryIndex = -1;
        input.value = promptDraft;
      }
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });

  // Typing while navigating exits history mode (but keeps text)
  input.addEventListener('input', () => {
    if (promptHistoryIndex !== -1) promptHistoryIndex = -1;
  });
}

// ── Preset Import/Export ─────────────────────────────────────────────────────

function downloadPresets() {
  window.location.href = '/api/presets/export';
}

async function uploadImportPresets() {
  const input = document.getElementById('preset-import-input');
  const statusEl = document.getElementById('preset-import-status');
  if (!input || !input.files.length) {
    showToast('Select a .json presets file first.', 'warning');
    return;
  }
  const file = input.files[0];

  const formData = new FormData();
  formData.append('file', file);

  if (statusEl) {
    statusEl.className = 'mt-2 font-mono text-[10px] text-[#ebcb8b]';
    statusEl.textContent = 'Importing…';
  }

  try {
    const res = await fetch('/api/presets/import', { method: 'POST', body: formData });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Import failed');
    if (statusEl) {
      statusEl.className = 'mt-2 font-mono text-[10px] text-[#a3be8c]';
      statusEl.textContent = `✓ ${d.message}`;
    }
    showToast(d.message, 'success');
    fetchPresets(); // refresh the preset dropdown in playground
    input.value = '';
  } catch (e) {
    if (statusEl) {
      statusEl.className = 'mt-2 font-mono text-[10px] text-[#bf616a]';
      statusEl.textContent = '✗ ' + e.message;
    }
    showToast('Import failed: ' + e.message, 'error');
  }
}

// ── Copy Response Button ──────────────────────────────────────────────────────

async function copyMessageToClipboard(index) {
  const msg = (typeof chatMessages !== 'undefined') ? chatMessages[index] : null;
  if (!msg) return;
  // Strip <think>…</think> blocks for a clean copy of the actual response
  let text = msg.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for non-secure contexts
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }

  // Visual feedback on the button
  const btn = document.getElementById(`copy-msg-${index}`);
  if (btn) {
    btn.innerHTML = '<i class="fa-solid fa-check text-[#a3be8c]"></i>';
    setTimeout(() => { btn.innerHTML = '<i class="fa-regular fa-copy"></i>'; }, 2000);
  }
  showToast('Copied to clipboard.', 'success');
}

function populateModelDropdowns() {
  const chatSelect = document.getElementById('chat-model-select');
  const builderSelect = document.getElementById('builder-base-select');
  const completionSelect = document.getElementById('completion-model-select');
  const benchmarkSelect = document.getElementById('benchmark-model-select');
  const optimizerSelect = document.getElementById('optimizer-model-select');
  const ragSelect = document.getElementById('rag-model-select');
  const chatRagSelect = document.getElementById('chat-rag-model-select');

  // Filter out models that might not have values
  const options = models.map(m => {
    const paramSize = (m.details && m.details.parameter_size) || '?';
    return `<option value="${m.name}">${m.name} (${paramSize})</option>`;
  }).join('');

  if (models.length === 0) {
    const noModels = '<option value="">-- No models available --</option>';
    if (chatSelect) chatSelect.innerHTML = noModels;
    if (builderSelect) builderSelect.innerHTML = noModels;
    if (completionSelect) completionSelect.innerHTML = noModels;
    if (benchmarkSelect) benchmarkSelect.innerHTML = noModels;
    if (optimizerSelect) optimizerSelect.innerHTML = noModels;
    if (ragSelect) ragSelect.innerHTML = noModels;
    if (chatRagSelect) chatRagSelect.innerHTML = noModels;
  } else {
    if (chatSelect) {
      const currentSelected = chatSelect.value || getPref('neurollama-chat-model') || '';
      chatSelect.innerHTML = options;
      if (currentSelected && chatSelect.querySelector(`option[value="${CSS.escape(currentSelected)}"]`)) {
        chatSelect.value = currentSelected;
      }
    }
    if (builderSelect) {
      const currentSelected = builderSelect.value || getPref('neurollama-builder-model') || '';
      builderSelect.innerHTML = '<option value="">-- Select a base model --</option>' + options;
      if (currentSelected && builderSelect.querySelector(`option[value="${CSS.escape(currentSelected)}"]`)) {
        builderSelect.value = currentSelected;
      }
    }
    if (benchmarkSelect) populateBenchmarkModelSelect();
    if (optimizerSelect) {
      const currentSelected = optimizerSelect.value || getPref('neurollama-optimizer-model') || '';
      optimizerSelect.innerHTML = options;
      if (currentSelected && optimizerSelect.querySelector(`option[value="${CSS.escape(currentSelected)}"]`)) {
        optimizerSelect.value = currentSelected;
      }
    }
    if (ragSelect) {
      const currentSelected = ragSelect.value || getPref('neurollama-rag-model') || '';
      ragSelect.innerHTML = options;
      if (currentSelected && ragSelect.querySelector(`option[value="${CSS.escape(currentSelected)}"]`)) {
        ragSelect.value = currentSelected;
      }
    }
    if (chatRagSelect) {
      const currentSelected = chatRagSelect.value || getPref('chat-rag-model-select') || '';
      chatRagSelect.innerHTML = options;
      if (currentSelected && chatRagSelect.querySelector(`option[value="${CSS.escape(currentSelected)}"]`)) {
        chatRagSelect.value = currentSelected;
      }
    }
    if (completionSelect) {
      const currentSelected = completionSelect.value || getPref('neurollama-completion-model') || '';
      completionSelect.innerHTML = options;
      if (currentSelected && completionSelect.querySelector(`option[value="${CSS.escape(currentSelected)}"]`)) {
        completionSelect.value = currentSelected;
      }
    }
  }
}

// --- TOAST SYSTEM ---
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  
  // Base classes
  toast.className = 'alert shadow-lg text-xs font-tech rounded-lg py-2 px-3 border transition-all duration-300 transform translate-y-2 opacity-0';
  
  // Theme colors
  if (type === 'success') {
    toast.className += ' bg-[#a3be8c] border-[#a3be8c] text-[#2e3440]';
  } else if (type === 'error') {
    toast.className += ' bg-[#bf616a] border-[#bf616a] text-[#eceff4]';
  } else if (type === 'warning') {
    toast.className += ' bg-[#ebcb8b] border-[#ebcb8b] text-[#2e3440]';
  } else { // info
    toast.className += ' bg-[#88c0d0] border-[#88c0d0] text-[#2e3440]';
  }

  // Content
  toast.innerHTML = `
    <div class="flex items-center gap-2">
      <i class="${type === 'success' ? 'fa-solid fa-circle-check' : type === 'error' ? 'fa-solid fa-circle-xmark' : 'fa-solid fa-circle-info'}"></i>
      <span>${message}</span>
    </div>
  `;
  
  container.appendChild(toast);
  
  // Trigger animation
  setTimeout(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  }, 10);

  // Remove toast
  setTimeout(() => {
    toast.classList.add('translate-y-2', 'opacity-0');
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 4000);
}

// Helper: return the active server's display name (name > hostname > URL)
function activeServerLabel() {
  const srv = servers.find(s => s.isActive);
  if (!srv) return null;
  if (srv.name) return srv.name;
  try { return new URL(srv.URL).hostname; } catch (_) { return srv.URL || null; }
}

function recordStreamFailure(area, message, ctx = {}) {
  const failures = JSON.parse(localStorage.getItem('neurollama-stream-failures') || '[]');
  failures.unshift({
    id: Date.now(),
    area,
    model: ctx.model || null,
    node:  ctx.node  || null,
    message: String(message || 'Unknown stream failure'),
    created_at: new Date().toISOString(),
    read: false,
  });
  localStorage.setItem('neurollama-stream-failures', JSON.stringify(failures.slice(0, 20)));
  renderStreamFailureLog();
  renderFailurePopover();
  updateFailureBadge();
}

function updateFailureBadge() {
  const failures = JSON.parse(localStorage.getItem('neurollama-stream-failures') || '[]');
  const unread = failures.filter(f => !f.read).length;
  const btn   = document.getElementById('failure-badge-btn');
  const count = document.getElementById('failure-badge-count');
  const sep   = document.getElementById('failure-badge-sep');
  if (!btn) return;
  const hasAny = failures.length > 0;
  btn.classList.toggle('hidden',   !hasAny);
  btn.classList.toggle('flex',      hasAny);
  if (sep) {
    sep.classList.toggle('hidden', !hasAny);
    sep.classList.toggle('inline', hasAny);
  }
  if (count) count.textContent = unread > 0 ? String(unread) : '';
  btn.classList.toggle('text-[#bf616a]', unread > 0);
  btn.classList.toggle('text-[#4c566a]', unread === 0 && hasAny);
}

function deleteStreamFailure(id) {
  let failures = JSON.parse(localStorage.getItem('neurollama-stream-failures') || '[]');
  failures = failures.filter(f => f.id !== id);
  localStorage.setItem('neurollama-stream-failures', JSON.stringify(failures));
  renderStreamFailureLog();
  renderFailurePopover();
  updateFailureBadge();
}

function markAllFailuresRead() {
  let failures = JSON.parse(localStorage.getItem('neurollama-stream-failures') || '[]');
  failures = failures.map(f => ({ ...f, read: true }));
  localStorage.setItem('neurollama-stream-failures', JSON.stringify(failures));
  renderStreamFailureLog();
  renderFailurePopover();
  updateFailureBadge();
}

function toggleFailurePopover() {
  const popover = document.getElementById('stream-failure-popover');
  if (!popover) return;
  const isHidden = popover.classList.contains('hidden');
  popover.classList.toggle('hidden', !isHidden);
  if (isHidden) {
    renderFailurePopover();
    markAllFailuresRead();
  }
}

function renderFailurePopover() {
  const container = document.getElementById('failure-popover-list');
  if (!container) return;
  const failures = JSON.parse(localStorage.getItem('neurollama-stream-failures') || '[]');
  if (failures.length === 0) {
    container.innerHTML = '<div class="text-[#4c566a] italic text-center py-4">No stream failures recorded.</div>';
    return;
  }
  container.innerHTML = failures.map(item => {
    const ts = new Date(item.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const unreadDot = !item.read
      ? `<span class="inline-block w-1.5 h-1.5 rounded-full bg-[#bf616a] mb-0.5 shrink-0"></span>` : '';
    return `
      <div class="flex items-start gap-2 py-2 border-b border-[#4c566a]/20 last:border-0">
        ${unreadDot}
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-1.5 flex-wrap mb-0.5">
            <span class="text-[#bf616a] font-bold uppercase text-[9px]">${escapeHTML(item.area)}</span>
            ${item.model ? `<span class="text-[#ebcb8b] font-mono text-[9px]">${escapeHTML(item.model)}</span>` : ''}
            ${item.node  ? `<span class="text-[#8fbcbb] text-[9px]">@ ${escapeHTML(item.node)}</span>` : ''}
            <span class="text-[#4c566a] text-[9px] ml-auto shrink-0">${ts}</span>
          </div>
          <div class="text-[#d8dee9]/80 text-[10px] break-words leading-relaxed">${escapeHTML(item.message)}</div>
        </div>
        <button onclick="deleteStreamFailure(${item.id})" title="Dismiss"
                class="shrink-0 text-[#4c566a] hover:text-[#bf616a] transition-colors ml-1 mt-0.5">
          <i class="fa-solid fa-xmark text-[10px]"></i>
        </button>
      </div>
    `;
  }).join('');
}

function renderStreamFailureLog() {
  const container = document.getElementById('stream-failure-log');
  if (!container) return;
  const failures = JSON.parse(localStorage.getItem('neurollama-stream-failures') || '[]');
  if (failures.length === 0) {
    container.innerHTML = '<div class="text-[#4c566a] italic">No stream failures recorded in this browser.</div>';
    return;
  }
  container.innerHTML = failures.map(item => `
    <div class="border border-[#4c566a]/30 bg-[#2e3440]/40 rounded-lg p-2${item.read ? '' : ' border-l-2 border-l-[#bf616a]'}">
      <div class="flex items-start justify-between gap-2 mb-1">
        <div class="flex items-center gap-1.5 flex-wrap">
          <span class="text-[#bf616a] font-bold uppercase">${escapeHTML(item.area)}</span>
          ${item.model ? `<span class="text-[#ebcb8b]">${escapeHTML(item.model)}</span>` : ''}
          ${item.node  ? `<span class="text-[#4c566a]">@ ${escapeHTML(item.node)}</span>` : ''}
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <span class="text-[#4c566a]">${new Date(item.created_at).toLocaleTimeString()}</span>
          <button onclick="deleteStreamFailure(${item.id})"
                  class="text-[#4c566a] hover:text-[#bf616a] transition-colors" title="Remove">
            <i class="fa-solid fa-xmark text-[9px]"></i>
          </button>
        </div>
      </div>
      <div class="text-[#d8dee9]/80 break-words">${escapeHTML(item.message)}</div>
    </div>
  `).join('');
}

function clearStreamFailureLog() {
  localStorage.removeItem('neurollama-stream-failures');
  renderStreamFailureLog();
  renderFailurePopover();
  updateFailureBadge();
  // Close popover if open
  const popover = document.getElementById('stream-failure-popover');
  if (popover) popover.classList.add('hidden');
  showToast('Stream failure log cleared', 'info');
}

async function runDiagnostics() {
  const btn = document.getElementById('diagnostics-run-btn');
  const container = document.getElementById('diagnostics-results');
  const generatedAt = document.getElementById('diagnostics-generated-at');
  if (btn) btn.disabled = true;
  if (container) {
    container.innerHTML = `
      <div class="flex items-center justify-center gap-2 py-16 text-xs text-[#88c0d0]">
        <i class="fa-solid fa-circle-notch animate-spin"></i>
        <span>Running preflight checks...</span>
      </div>
    `;
  }

  try {
    const response = await fetch('/api/diagnostics');
    if (!response.ok) {
      let message = 'Diagnostics failed';
      const contentType = response.headers.get('content-type') || '';
      if (response.status === 404) {
        message = 'Diagnostics API not found. Restart NEUROLLAMA so the backend matches this frontend.';
      } else if (contentType.includes('application/json')) {
        const err = await response.json();
        message = err.error || message;
      } else {
        const body = await response.text();
        message = body || `${message} (${response.status})`;
      }
      throw new Error(message);
    }
    const data = await response.json();
    const checks = data.checks || [];
    const counts = checks.reduce((acc, check) => {
      acc[check.status] = (acc[check.status] || 0) + 1;
      return acc;
    }, {});

    const passEl = document.getElementById('diag-pass-count');
    const warnEl = document.getElementById('diag-warn-count');
    const failEl = document.getElementById('diag-fail-count');
    if (passEl) passEl.textContent = counts.pass || 0;
    if (warnEl) warnEl.textContent = counts.warn || 0;
    if (failEl) failEl.textContent = counts.fail || 0;
    if (generatedAt) generatedAt.textContent = data.generated_at ? `Generated ${new Date(data.generated_at).toLocaleString()}` : 'Generated now';

    const styleForStatus = (status) => {
      if (status === 'pass') return { icon: 'fa-circle-check', color: 'text-[#a3be8c]', border: 'border-[#a3be8c]/35', bg: 'bg-[#a3be8c]/5' };
      if (status === 'warn') return { icon: 'fa-triangle-exclamation', color: 'text-[#ebcb8b]', border: 'border-[#ebcb8b]/35', bg: 'bg-[#ebcb8b]/5' };
      return { icon: 'fa-circle-xmark', color: 'text-[#bf616a]', border: 'border-[#bf616a]/35', bg: 'bg-[#bf616a]/5' };
    };

    if (container) {
      container.innerHTML = checks.map(check => {
        const style = styleForStatus(check.status);
        return `
          <div class="border ${style.border} ${style.bg} rounded-lg p-3 font-mono text-xs">
            <div class="flex items-center justify-between gap-3 mb-1">
              <span class="${style.color} font-bold flex items-center gap-1.5 uppercase">
                <i class="fa-solid ${style.icon}"></i> ${escapeHTML(check.name)}
              </span>
              <span class="${style.color} text-[9px] uppercase font-bold">${escapeHTML(check.status)}</span>
            </div>
            <div class="text-[#d8dee9]">${escapeHTML(check.message)}</div>
            ${check.details ? `<div class="text-[#4c566a] text-[10px] mt-1 break-words">${escapeHTML(check.details)}</div>` : ''}
          </div>
        `;
      }).join('');
    }
  } catch (error) {
    if (container) {
      container.innerHTML = `<div class="text-center py-16 text-[#bf616a] italic text-xs">Diagnostics failed: ${escapeHTML(error.message)}</div>`;
    }
    showToast(error.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// --- SERVER MANAGEMENT ---

async function fetchServers() {
  try {
    const response = await fetch('/api/servers');
    if (!response.ok) throw new Error('Failed to fetch servers');
    servers = await response.json();
    // Seed last-seen timestamps for all servers
    const now = Date.now();
    servers.forEach(s => { serverLastSeen[s.id] = now; });
    renderServers();

    const active = servers.find(s => s.isActive);
    updateActiveServerUI(active);
  } catch (error) {
    console.error(error);
    showToast('Failed to connect to node registry backend', 'error');
  }
}

function renderServers() {
  const listContainer = document.getElementById('server-list');
  if (servers.length === 0) {
    listContainer.innerHTML = `
      <div class="text-center py-8 text-[#4c566a] italic text-xs">
        No Ollama nodes configured. Add one to get started.
      </div>
    `;
    return;
  }

  listContainer.innerHTML = servers.map(srv => {
    const isOnline = srv.status === 'online';
    const statusDot = isOnline 
      ? '<span class="h-2.5 w-2.5 rounded-full bg-[#a3be8c] status-glow-online"></span>' 
      : '<span class="h-2.5 w-2.5 rounded-full bg-[#bf616a] status-glow-offline"></span>';
    
    const activeBorder = srv.isActive 
      ? 'border-[#88c0d0] bg-[#3b4252]/40 shadow-sm shadow-[#88c0d0]/10' 
      : 'border-[#4c566a]/30 hover:border-[#4c566a]/70';

    const hasAuth = srv.authType && srv.authType !== 'none';
    const authLock = hasAuth 
      ? '<i class="fa-solid fa-lock text-[10px] text-[#a3be8c] ml-1.5" title="Auth Configured"></i>' 
      : '';

    return `
      <div class="p-3 border rounded-lg flex flex-col justify-between gap-2 transition-all ${activeBorder} group">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 cursor-pointer flex-1" onclick="selectServer('${srv.id}')">
            ${statusDot}
            <div>
              <h3 class="font-bold text-xs truncate max-w-[130px] text-[#e5e9f0] group-hover:text-[#88c0d0] transition-colors flex items-center">
                ${srv.name}${authLock}
              </h3>
              <p class="text-[9px] font-mono text-[#4c566a] truncate max-w-[130px]">${srv.url}</p>
            </div>
          </div>
          <div class="flex items-center gap-1 opacity-40 group-hover:opacity-100 transition-opacity">
            <button onclick="openEditServerModal('${srv.id}')" class="btn btn-ghost btn-xs p-1 text-[#88c0d0]" title="Edit Node">
              <i class="fa-solid fa-pen"></i>
            </button>
            <button onclick="deleteServer('${srv.id}')" class="btn btn-ghost btn-xs p-1 text-[#bf616a]" title="Delete Node">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </div>
        </div>
        <div class="flex items-center justify-between text-[9px] font-mono text-[#4c566a]">
          <span>${isOnline ? `Version: ${srv.version}` : 'UNREACHABLE'}</span>
          <div class="flex items-center gap-1">
            <span>${isOnline ? `${srv.latency} ms` : ''}</span>
            <span class="opacity-60">${serverLastSeen[srv.id] ? timeAgoShort(serverLastSeen[srv.id]) : ''}</span>
            <button onclick="event.stopPropagation(); refreshNode('${srv.id}')"
                    class="opacity-0 group-hover:opacity-100 transition-opacity text-[#4c566a] hover:text-[#88c0d0] leading-none"
                    title="Refresh node status">
              <i class="fa-solid fa-rotate text-[9px]"></i>
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// Cached result from /api/ollama-latest { stable, prerelease, fetchedAt }
let ollamaLatestInfo = null;

async function checkOllamaVersionDot(version) {
  const dot = document.getElementById('ollama-version-dot');
  if (!dot) return;
  if (!version) { dot.classList.add('hidden'); return; }

  // Refresh cache at most once per hour
  const now = Date.now();
  if (!ollamaLatestInfo || (now - ollamaLatestInfo.fetchedAt) > 3_600_000) {
    try {
      const r = await fetch('/api/ollama-latest');
      if (!r.ok) throw new Error();
      const d = await r.json();
      ollamaLatestInfo = { stable: d.stable || '', prerelease: d.prerelease || '', fetchedAt: now };
    } catch {
      dot.classList.add('hidden');
      return;
    }
  }

  const { stable, prerelease } = ollamaLatestInfo;
  if (!stable) { dot.classList.add('hidden'); return; }

  const cmpStable = compareVersions(version, stable);
  let color, title;

  if (cmpStable === 0) {
    // Running latest stable
    color = 'bg-[#a3be8c]';
    title = `Up to date — v${version} is the latest stable release`;
  } else if (cmpStable > 0) {
    // Ahead of stable — on a pre-release build
    color = 'bg-[#88c0d0]';
    title = `Pre-release v${version} — latest stable is v${stable}`;
  } else {
    // Behind stable — update available
    color = 'bg-[#ebcb8b]';
    title = `Update available: v${stable} (running v${version})`;
    if (prerelease && compareVersions(prerelease, stable) > 0) {
      title += ` · Pre-release v${prerelease} also available`;
    }
  }

  dot.className = `h-2 w-2 rounded-full shrink-0 cursor-default transition-colors ${color}`;
  dot.title = title;
  dot.classList.remove('hidden');
  // Now that ollamaLatestInfo is populated, refine the footer badge too
  updateFooterNodeBadge();
}

function updateActiveServerUI(srv) {
  const srvName = document.getElementById('global-active-server-name');
  const srvLatency = document.getElementById('global-active-server-latency');
  const statusIndicator = document.getElementById('global-active-server-status-indicator');
  const statusText = document.getElementById('global-active-server-status-text');

  if (srv) {
    srvName.textContent = srv.name;
    srvName.title = srv.name;
    const isOnline = srv.status === 'online';
    
    if (isOnline) {
      srvLatency.textContent = `${srv.latency} ms`;
      statusIndicator.className = 'h-2.5 w-2.5 rounded-full bg-[#a3be8c] status-glow-online inline-block';
      statusText.textContent = 'ONLINE';
      statusText.className = 'text-xs uppercase text-[#a3be8c] font-semibold font-tech';
      checkOllamaVersionDot(srv.version);
      updateFooterNodeBadge();
    } else {
      srvLatency.textContent = '-- ms';
      statusIndicator.className = 'h-2.5 w-2.5 rounded-full bg-[#bf616a] inline-block';
      statusText.textContent = 'OFFLINE';
      statusText.className = 'text-xs uppercase text-[#bf616a] font-semibold font-tech';
      const dot = document.getElementById('ollama-version-dot');
      if (dot) dot.classList.add('hidden');
      updateFooterNodeBadge();
    }
  } else {
    srvName.textContent = '---';
    srvName.title = '';
    srvLatency.textContent = '-- ms';
    statusIndicator.className = 'h-2.5 w-2.5 rounded-full bg-[#4c566a] inline-block';
    statusText.textContent = 'NONE';
    statusText.className = 'text-xs uppercase text-[#4c566a] font-semibold font-tech';
    const dot = document.getElementById('ollama-version-dot');
    if (dot) dot.classList.add('hidden');
    updateFooterNodeBadge();
  }
}

// ── Footer node channel badge ────────────────────────────────────────────────

function updateFooterNodeBadge() {
  const dot  = document.getElementById('footer-node-channel-dot');
  const txt  = document.getElementById('footer-node-channel-text');
  const btn  = document.getElementById('footer-node-btn');
  if (!dot || !txt) return;

  const active = servers.find(s => s.isActive);

  if (!active || active.status !== 'online' || !active.version) {
    dot.className  = 'h-2 w-2 rounded-full bg-[#4c566a] shrink-0';
    txt.textContent = active ? 'OFFLINE' : '—';
    txt.className  = 'font-semibold text-[#4c566a]';
    if (btn) btn.classList.add('hidden');
    return;
  }

  if (btn) btn.classList.remove('hidden');
  const stable = ollamaLatestInfo?.stable || '';

  if (!stable) {
    // GitHub data not loaded yet — show online, update once available
    dot.className  = 'h-2 w-2 rounded-full bg-[#a3be8c] shrink-0';
    txt.textContent = 'ONLINE';
    txt.className  = 'font-semibold text-[#a3be8c]';
    return;
  }

  if (compareVersions(active.version, stable) > 0) {
    dot.className  = 'h-2 w-2 rounded-full bg-[#88c0d0] shrink-0';
    txt.textContent = 'PRE-REL';
    txt.className  = 'font-semibold text-[#88c0d0]';
  } else {
    dot.className  = 'h-2 w-2 rounded-full bg-[#a3be8c] shrink-0';
    txt.textContent = 'STABLE';
    txt.className  = 'font-semibold text-[#a3be8c]';
  }
}

// ── Node selector slide-out ──────────────────────────────────────────────────

function renderNodeSlideout() {
  const list = document.getElementById('node-slideout-list');
  if (!list) return;

  if (!servers.length) {
    list.innerHTML = '<div class="text-[#4c566a] text-center py-4 text-[10px]">No nodes configured.</div>';
    return;
  }

  const stable = ollamaLatestInfo?.stable || '';

  list.innerHTML = servers.map(s => {
    const isOnline = s.status === 'online';
    const isActive = !!s.isActive;

    // Channel badge
    let channelBadge = '';
    if (isOnline && s.version && stable) {
      channelBadge = compareVersions(s.version, stable) > 0
        ? `<span class="shrink-0 text-[8px] px-1.5 py-0.5 rounded bg-[#88c0d0]/15 text-[#88c0d0] border border-[#88c0d0]/30 font-tech">PRE</span>`
        : `<span class="shrink-0 text-[8px] px-1.5 py-0.5 rounded bg-[#a3be8c]/15 text-[#a3be8c] border border-[#a3be8c]/30 font-tech">STABLE</span>`;
    }

    // Action area
    const actionArea = isActive
      ? `<span class="shrink-0 text-[8px] px-1.5 py-0.5 rounded bg-[#81a1c1]/15 text-[#81a1c1] border border-[#81a1c1]/30 font-tech">ACTIVE</span>`
      : `<button onclick="selectServer('${escapeHTML(s.id)}');closeNodeSlideout();"
                 class="shrink-0 text-[8px] px-1.5 py-0.5 rounded border border-[#4c566a] text-[#4c566a] hover:border-[#88c0d0] hover:text-[#88c0d0] transition-colors font-tech whitespace-nowrap">
           SET
         </button>`;

    return `
      <div class="flex items-center gap-2 px-2 py-2 rounded-lg transition-colors ${isActive ? 'bg-[#3b4252]/60' : 'hover:bg-[#2e3440]'}">
        <span class="h-2 w-2 rounded-full shrink-0 ${isOnline ? 'bg-[#a3be8c]' : 'bg-[#bf616a]'}"></span>
        <div class="flex-1 min-w-0">
          <div class="text-[#d8dee9] truncate">${escapeHTML(s.name)}</div>
          <div class="text-[9px] ${isOnline ? 'text-[#4c566a]' : 'text-[#bf616a]'}">
            ${isOnline
              ? `v${escapeHTML(s.version || '?')} · ${s.latency ?? '—'} ms`
              : 'OFFLINE'}
          </div>
        </div>
        ${channelBadge}
        ${actionArea}
      </div>`;
  }).join('');
}

function toggleNodeSlideout() {
  const panel   = document.getElementById('node-slideout');
  const chevron = document.getElementById('footer-node-chevron');
  if (!panel) return;
  const open = panel.classList.contains('hidden');
  if (open) {
    renderNodeSlideout();
    panel.classList.remove('hidden');
    if (chevron) chevron.style.transform = 'rotate(180deg)';
  } else {
    panel.classList.add('hidden');
    if (chevron) chevron.style.transform = '';
  }
}

function closeNodeSlideout() {
  const panel   = document.getElementById('node-slideout');
  const chevron = document.getElementById('footer-node-chevron');
  if (panel)   panel.classList.add('hidden');
  if (chevron) chevron.style.transform = '';
}

async function selectServer(id) {
  try {
    const response = await fetch(`/api/servers/${id}/select`, { method: 'POST' });
    if (!response.ok) throw new Error('Failed to select server');

    const updatedSrv = await response.json();
    showToast(`Switched active node to ${updatedSrv.name}`, 'success');

    // Update local state directly — no full re-fetch needed.
    servers = servers.map(s => ({
      ...s,
      isActive: s.id === id,
      ...(s.id === id
        ? { status: updatedSrv.status, latency: updatedSrv.latency, version: updatedSrv.version }
        : {}),
    }));
    renderServers();
    updateActiveServerUI(servers.find(s => s.isActive));

    modelsLoaded = false;
    selectedModels.clear();
    document.getElementById('select-all-checkbox').checked = false;
    updateBatchActionsUI();
    clearInspectedModel();
    resetChatSession();
    // Clear any cross-node search so the inventory shows only the new node's models.
    if (crossNodeSearchQuery) clearCrossNodeSearch(true);

    if (updatedSrv.status === 'online') {
      await fetchModels();
      populateModelDropdowns();
      if (activeWorkspace === 'system' && activeSystemSubtab === 'memory') fetchActiveModels();
    } else {
      renderModelsEmpty('Selected node is offline');
      populateModelDropdowns();
    }
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function handleAddServer(event) {
  event.preventDefault();
  const payload = getServerFormPayload('add');
  const name = payload.name;

  try {
    const response = await fetch('/api/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to add server');
    }

    const newSrv = await response.json();
    showToast(`Node '${name}' registered successfully`, 'success');
    closeAddServerModal();
    document.getElementById('add-server-form').reset();
    toggleAuthFields('add');

    // Push directly into local state — backend sets isActive when it is the first server.
    const wasEmpty = servers.length === 0;
    servers.push(newSrv);
    renderServers();
    updateActiveServerUI(servers.find(s => s.isActive));

    modelsLoaded = false;
    if (wasEmpty && newSrv.status === 'online') {
      await fetchModels();
      populateModelDropdowns();
    }
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function handleEditServer(event) {
  event.preventDefault();
  const id = document.getElementById('edit-server-id').value;
  const payload = getServerFormPayload('edit');
  const name = payload.name;

  try {
    const response = await fetch(`/api/servers/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to edit server');
    }

    const updatedSrv = await response.json();
    showToast(`Node '${name}' updated successfully`, 'success');
    closeEditServerModal();

    // Update local state directly — no full re-fetch needed.
    const idx = servers.findIndex(s => s.id === id);
    if (idx !== -1) servers[idx] = { ...servers[idx], ...updatedSrv };
    renderServers();
    updateActiveServerUI(servers.find(s => s.isActive));

    const active = servers.find(s => s.isActive);
    if (active && active.id === id) {
      modelsLoaded = false;
      if (active.status === 'online') {
        await fetchModels();
        populateModelDropdowns();
      } else {
        renderModelsEmpty('Active node is offline');
        populateModelDropdowns();
      }
    }
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function deleteServer(id) {
  const srv = servers.find(s => s.id === id);
  if (!srv) return;
  
  if (!confirm(`Are you sure you want to remove node '${srv.name}'?`)) return;

  try {
    const response = await fetch(`/api/servers/${id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('Failed to delete server');

    showToast(`Node '${srv.name}' removed`, 'warning');
    const wasActive = srv.isActive;

    // Mirror backend logic: remove from local state, auto-promote servers[0] if active was deleted.
    servers = servers.filter(s => s.id !== id);
    if (wasActive && servers.length > 0) {
      servers[0] = { ...servers[0], isActive: true };
    }
    renderServers();
    updateActiveServerUI(servers.find(s => s.isActive));

    if (wasActive) {
      modelsLoaded = false;
      const newActive = servers.find(s => s.isActive);
      if (newActive && newActive.status === 'online') {
        await fetchModels();
        populateModelDropdowns();
      } else {
        renderModelsEmpty(newActive ? 'Active node is offline' : 'No active server configured');
        populateModelDropdowns();
      }
      clearInspectedModel();
      resetChatSession();
    }
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// Modals control
function getServerFormPayload(prefix) {
  const vramRaw = document.getElementById(`${prefix}-server-vram`)?.value;
  return {
    name: document.getElementById(`${prefix}-server-name`).value.trim(),
    url: document.getElementById(`${prefix}-server-url`).value.trim(),
    vramGb: vramRaw ? parseFloat(vramRaw) : 0,
    authType: document.getElementById(`${prefix}-server-auth-type`).value,
    authToken: document.getElementById(`${prefix}-server-auth-token`).value,
    authUsername: document.getElementById(`${prefix}-server-auth-username`).value,
    authPassword: document.getElementById(`${prefix}-server-auth-password`).value,
    authHeaderName: document.getElementById(`${prefix}-server-auth-header-name`).value,
    authHeaderVal: document.getElementById(`${prefix}-server-auth-header-val`).value
  };
}

async function testNodeConnection(prefix) {
  const payload = getServerFormPayload(prefix);
  if (!payload.name || !payload.url) {
    showToast('Enter node name and URL before testing', 'warning');
    return;
  }

  const id = prefix === 'edit' ? document.getElementById('edit-server-id').value : '';
  const endpoint = prefix === 'edit' && id ? `/api/servers/${id}/test` : '/api/servers/test';

  try {
    showToast('Testing node authentication and reachability...', 'info');
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.message || data.error || 'Node test failed');
    }
    const version = data.version ? ` // ${data.version}` : '';
    showToast(`Node online in ${data.latency || 0}ms${version}`, 'success');
  } catch (error) {
    showToast(`Node test failed: ${error.message}`, 'error');
  }
}

function toggleAuthFields(prefix) {
  const selectEl = document.getElementById(`${prefix}-server-auth-type`);
  if (!selectEl) return;
  const type = selectEl.value;
  
  const bearerDiv = document.getElementById(`${prefix}-auth-fields-bearer`);
  const basicDiv = document.getElementById(`${prefix}-auth-fields-basic`);
  const customDiv = document.getElementById(`${prefix}-auth-fields-custom`);
  
  if (bearerDiv) bearerDiv.classList.toggle('hidden', type !== 'bearer');
  if (basicDiv) basicDiv.classList.toggle('hidden', type !== 'basic');
  if (customDiv) customDiv.classList.toggle('hidden', type !== 'custom');
}

function openAddServerModal() {
  const form = document.getElementById('add-server-form');
  if (form) form.reset();
  toggleAuthFields('add');
  document.getElementById('add-server-modal').showModal();
}
function closeAddServerModal() {
  document.getElementById('add-server-modal').close();
}
function openEditServerModal(id) {
  const srv = servers.find(s => s.id === id);
  if (!srv) return;

  document.getElementById('edit-server-id').value = srv.id;
  document.getElementById('edit-server-name').value = srv.name;
  document.getElementById('edit-server-url').value = srv.url;
  const vramEl = document.getElementById('edit-server-vram');
  if (vramEl) vramEl.value = srv.vramGb > 0 ? srv.vramGb : '';
  
  const typeEl = document.getElementById('edit-server-auth-type');
  if (typeEl) typeEl.value = srv.authType || 'none';
  
  const tokenEl = document.getElementById('edit-server-auth-token');
  if (tokenEl) tokenEl.value = '';
  
  const usernameEl = document.getElementById('edit-server-auth-username');
  if (usernameEl) usernameEl.value = srv.authUsername || '';
  
  const passwordEl = document.getElementById('edit-server-auth-password');
  if (passwordEl) passwordEl.value = '';
  
  const headerNameEl = document.getElementById('edit-server-auth-header-name');
  if (headerNameEl) headerNameEl.value = srv.authHeaderName || '';
  
  const headerValEl = document.getElementById('edit-server-auth-header-val');
  if (headerValEl) headerValEl.value = '';
  
  toggleAuthFields('edit');
  document.getElementById('edit-server-modal').showModal();
}
function closeEditServerModal() {
  document.getElementById('edit-server-modal').close();
}

// --- MODEL REGISTRY ---

async function fetchModels() {
  const listBody = document.getElementById('models-list-body');
  listBody.innerHTML = `
    <tr>
      <td colspan="5" class="py-8 text-center text-[#4c566a]">
        <i class="fa-solid fa-circle-notch animate-spin mr-2"></i> Querying inventory...
      </td>
    </tr>
  `;

  try {
    const response = await fetch('/api/models');
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.details || err.error || 'Failed to fetch models');
    }
    
    const data = await response.json();
    models = data.models || [];
    if (data.lastUpdated) lastModelSyncTs = data.lastUpdated;
    inventoryPage = 1; // reset to first page on fresh load
    modelsLoaded = true;
    renderModels();
    updateInventorySyncBadge();
    // Keep all model dropdowns in sync regardless of which workspace is active.
    populateModelDropdowns();
    // Persist for stale-while-revalidate on next page load.
    try {
      localStorage.setItem('neurollama-model-cache', JSON.stringify({ models, ts: Date.now() }));
    } catch { /* storage quota exceeded — skip */ }
  } catch (error) {
    console.error(error);
    renderModelsEmpty(error.message);
  }
}

function initAccordionRow() {
  accordionEl = document.createElement('tr');
  accordionEl.id = 'model-detail-accordion';
  accordionEl.style.display = 'none';
  accordionEl.innerHTML = `
    <td colspan="5" class="p-0">
      <div class="mx-1 mb-1 p-4 bg-[#1e2430] border border-[#88c0d0]/25 border-t-0 rounded-b-lg text-xs">
        <div class="flex items-center justify-between mb-3 pb-2 border-b border-[#4c566a]/40">
          <div class="flex flex-wrap gap-1.5 items-center">
            <span class="font-tech text-[11px] font-bold text-[#88c0d0] mr-2"><i class="fa-solid fa-microchip mr-1"></i>Telemetry</span>
            <span id="badge-format" class="badge badge-outline border-[#4c566a] text-[#81a1c1] text-[10px] font-semibold"></span>
            <span id="badge-family" class="badge badge-outline border-[#4c566a] text-[#88c0d0] text-[10px] font-semibold"></span>
            <span id="badge-quant" class="badge badge-outline border-[#4c566a] text-[#a3be8c] text-[10px] font-semibold"></span>
            <span id="badge-params" class="badge badge-outline border-[#4c566a] text-[#ebcb8b] text-[10px] font-semibold"></span>
            <span class="text-[10px] text-[#4c566a] font-mono ml-2">Digest: <span id="detail-digest" class="text-[#81a1c1]"></span></span>
          </div>
          <button onclick="clearInspectedModel()" class="btn btn-xs btn-ghost text-[#4c566a] hover:text-[#bf616a] p-1" title="Close">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
        <div class="flex gap-1 bg-[#242933]/60 p-1 border border-[#4c566a]/40 mb-3 rounded-lg">
          <button id="detail-tab-modelfile" onclick="switchDetailTab('modelfile')" class="detail-tab detail-tab-active">FILE</button>
          <button id="detail-tab-parameters" onclick="switchDetailTab('parameters')" class="detail-tab">PARAMS</button>
          <button id="detail-tab-template" onclick="switchDetailTab('template')" class="detail-tab">TEMPLATE</button>
          <button id="detail-tab-system" onclick="switchDetailTab('system')" class="detail-tab">SYSTEM</button>
          <button id="detail-tab-card" onclick="switchDetailTab('card')" class="detail-tab">CARD</button>
        </div>
        <div class="overflow-auto max-h-72 bg-[#161820] border border-[#4c566a]/60 rounded-lg p-3 text-[11px] font-mono text-[#d8dee9] relative">
          <button onclick="copyTabContent()" class="btn btn-xs btn-neutral absolute top-2 right-2 border-[#4c566a] hover:bg-[#4c566a]" title="Copy to clipboard">
            <i class="fa-regular fa-copy"></i>
          </button>
          <div id="tab-content-text" class="whitespace-pre-wrap break-all pr-8 leading-relaxed font-tech">Loading...</div>
        </div>
      </div>
    </td>`;
}

function modelRowId(name) {
  return 'model-row-' + name.replace(/[^a-zA-Z0-9]/g, '-');
}

// ── Pagination helpers ────────────────────────────────────────────────────────

function renderPagination() {
  const container = document.getElementById('inventory-pagination');
  const pageInfo  = document.getElementById('inventory-page-info');
  const pageInd   = document.getElementById('inventory-page-indicator');
  const prevBtn   = document.getElementById('inventory-prev-btn');
  const nextBtn   = document.getElementById('inventory-next-btn');
  const sizeEl    = document.getElementById('inventory-page-size');
  if (!container) return;

  const total      = models.length;
  const totalPages = Math.max(1, Math.ceil(total / inventoryPageSize));
  const start      = (inventoryPage - 1) * inventoryPageSize + 1;
  const end        = Math.min(inventoryPage * inventoryPageSize, total);

  if (total <= inventoryPageSize) {
    container.classList.add('hidden');
    container.classList.remove('flex');
    return;
  }

  container.classList.remove('hidden');
  container.classList.add('flex');
  if (pageInfo)  pageInfo.textContent  = `${start}–${end} of ${total}`;
  if (pageInd)   pageInd.textContent   = `${inventoryPage} / ${totalPages}`;
  if (prevBtn)   prevBtn.disabled      = inventoryPage <= 1;
  if (nextBtn)   nextBtn.disabled      = inventoryPage >= totalPages;

  // Keep select element in sync with current page size
  if (sizeEl) sizeEl.value = String(inventoryPageSize);
}

function inventoryPrevPage() {
  if (inventoryPage > 1) { inventoryPage--; renderModels(); }
}
function inventoryNextPage() {
  const totalPages = Math.ceil(models.length / inventoryPageSize);
  if (inventoryPage < totalPages) { inventoryPage++; renderModels(); }
}
function setInventoryPageSize(val) {
  inventoryPageSize = parseInt(val, 10) || 50;
  inventoryPage = 1;
  renderModels();
}

// ── Inventory sync badge ──────────────────────────────────────────────────────

function updateInventorySyncBadge() {
  const el = document.getElementById('inventory-last-synced');
  if (!el) return;
  if (!lastModelSyncTs) { el.classList.add('hidden'); return; }
  el.textContent = `synced ${timeAgoShort(lastModelSyncTs * 1000)}`;
  el.classList.remove('hidden');
}

// Refresh model list manually (wires the ↺ button in the inventory header).
function refreshInventory() {
  modelsLoaded = false;
  fetchModels();
}

// ── Server last-seen helpers ──────────────────────────────────────────────────

function timeAgoShort(tsMs) {
  const sec = Math.floor((Date.now() - tsMs) / 1000);
  if (sec < 5)   return 'just now';
  if (sec < 60)  return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

// Refresh a single node via POST /api/nodes/:id/refresh (Phase 2 endpoint).
async function refreshNode(id) {
  try {
    const response = await fetch(`/api/nodes/${id}/refresh`, { method: 'POST' });
    if (!response.ok) throw new Error('Refresh failed');
    const updated = await response.json();
    handleNodeStatusUpdate(updated);
    serverLastSeen[id] = Date.now();
    showToast(`Node ${updated.name} refreshed`, 'success');
  } catch (e) {
    showToast('Node refresh failed', 'error');
  }
}

// ── Model inventory render ────────────────────────────────────────────────────

function renderModels() {
  const listBody = document.getElementById('models-list-body');

  // Update total badge
  const totalBadge = document.getElementById('inventory-total-badge');
  if (totalBadge) {
    if (models.length > 0) {
      totalBadge.textContent = `(${models.length})`;
      totalBadge.classList.remove('hidden');
    } else {
      totalBadge.classList.add('hidden');
    }
  }

  if (models.length === 0) {
    listBody.innerHTML = `
      <tr>
        <td colspan="5" class="text-center py-8 text-[#4c566a] italic">
          No models found on this server. Pull a model above to begin.
        </td>
      </tr>
    `;
    renderPagination();
    return;
  }

  // Client-side page slice
  const totalPages = Math.ceil(models.length / inventoryPageSize);
  if (inventoryPage > totalPages) inventoryPage = totalPages;
  const start = (inventoryPage - 1) * inventoryPageSize;
  const pageModels = models.slice(start, start + inventoryPageSize);

  // Detach accordion before wiping innerHTML
  if (accordionEl && accordionEl.parentNode === listBody) {
    listBody.removeChild(accordionEl);
  }

  listBody.innerHTML = pageModels.map(model => {
    const isChecked = selectedModels.has(model.name);
    const dateFormatted = new Date(model.modified_at).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
    const sizeFormatted = formatBytes(model.size);
    const paramSize = (model.details && model.details.parameter_size) || 'N/A';
    const rowId = modelRowId(model.name);
    const isOpen = openAccordionModel === model.name;

    // Capability badges
    const caps = getModelCapabilities(model);
    const capBadgeHtml = [
      caps.includes('vision')    ? '<span class="inline-flex items-center gap-0.5 border border-[#b48ead] text-[#b48ead] rounded px-1 text-[8px] font-mono font-bold"><i class="fa-solid fa-eye text-[7px]"></i>VIS</span>' : '',
      caps.includes('embedding') ? '<span class="inline-flex items-center gap-0.5 border border-[#ebcb8b] text-[#ebcb8b] rounded px-1 text-[8px] font-mono font-bold"><i class="fa-solid fa-layer-group text-[7px]"></i>EMB</span>' : '',
    ].filter(Boolean).join('');

    return `
      <tr id="${rowId}" class="hover:bg-[#3b4252]/30 border-b border-[#4c566a]/30 transition-colors${isOpen ? ' bg-[#3b4252]/20' : ''}">
        <td>
          <input type="checkbox" onchange="toggleSelectModel('${model.name}', this.checked)" ${isChecked ? 'checked' : ''}
                 class="checkbox checkbox-xs checkbox-primary border-[#4c566a]" />
        </td>
        <td>
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="font-bold text-[#e5e9f0] cursor-pointer hover:text-[#88c0d0] transition-colors" onclick="inspectModel('${model.name}')">${model.name}</span>
            ${capBadgeHtml}
          </div>
          <span class="text-[9px] text-[#4c566a] block sm:hidden">${sizeFormatted} // ${paramSize}</span>
          <span class="text-[9px] text-[#4c566a] block">Modified: ${dateFormatted}</span>
        </td>
        <td class="hidden sm:table-cell">${sizeFormatted}</td>
        <td class="hidden md:table-cell">
          <span class="badge badge-outline border-[#4c566a] text-[#81a1c1] text-[9px] font-mono">${paramSize}</span>
        </td>
        <td>
          <div class="flex items-center gap-1.5">
            <button onclick="inspectModel('${model.name}')" class="btn btn-xs btn-neutral border-[#4c566a] text-[10px] font-tech w-[62px]" title="Inspect Telemetry">
              ${isOpen ? 'CLOSE' : 'INSPECT'}
            </button>
            <button onclick="cloneModelPrompt('${model.name}')" class="btn btn-xs btn-outline btn-info text-[10px] font-tech" title="Clone Model">
              CLONE
            </button>
            <button onclick="deleteSingleModel('${model.name}')" class="btn btn-xs btn-ghost text-[#bf616a] hover:bg-[#bf616a]/15 p-1" title="Delete Model">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  // Re-append accordion and restore its position if a model is open
  if (accordionEl) {
    if (openAccordionModel) {
      const targetRow = document.getElementById(modelRowId(openAccordionModel));
      if (targetRow) {
        targetRow.insertAdjacentElement('afterend', accordionEl);
        accordionEl.style.display = '';
      } else {
        listBody.appendChild(accordionEl);
        accordionEl.style.display = 'none';
        openAccordionModel = null;
      }
    } else {
      listBody.appendChild(accordionEl);
    }
  }

  // Re-check select all box — reflects the current page only
  const allChecked = pageModels.length > 0 && pageModels.every(m => selectedModels.has(m.name));
  document.getElementById('select-all-checkbox').checked = allChecked;

  // Render pagination controls
  renderPagination();

  // Update catalog state (installed badges)
  renderCatalog();
}

function renderModelsEmpty(message) {
  models = [];
  const listBody = document.getElementById('models-list-body');
  listBody.innerHTML = `
    <tr>
      <td colspan="5" class="text-center py-8 text-[#bf616a]/80 font-semibold italic text-xs">
        <i class="fa-solid fa-circle-exclamation mr-1.5"></i> ${message}
      </td>
    </tr>
  `;
}

// Select operations
function toggleSelectModel(name, checked) {
  if (checked) {
    selectedModels.add(name);
  } else {
    selectedModels.delete(name);
  }
  
  // Update select all state
  const allChecked = models.length > 0 && models.every(m => selectedModels.has(m.name));
  document.getElementById('select-all-checkbox').checked = allChecked;

  updateBatchActionsUI();
}

function toggleSelectAllModels(checkbox) {
  // Operate on the current page slice only
  const start = (inventoryPage - 1) * inventoryPageSize;
  const pageModels = models.slice(start, start + inventoryPageSize);
  if (checkbox.checked) {
    pageModels.forEach(m => selectedModels.add(m.name));
  } else {
    pageModels.forEach(m => selectedModels.delete(m.name));
  }
  renderModels();
  updateBatchActionsUI();
}

function updateBatchActionsUI() {
  const container = document.getElementById('batch-actions-container');
  const countSpan = document.getElementById('selected-count');
  
  if (selectedModels.size > 0) {
    container.classList.remove('hidden');
    countSpan.textContent = selectedModels.size;
  } else {
    container.classList.add('hidden');
  }
}

async function cloneModelPrompt(source) {
  const destination = prompt(`Enter a new name to clone/copy '${source}' to:`, `${source}-copy`);
  if (!destination || !destination.trim()) return;

  try {
    const response = await fetch('/api/models/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: source,
        destination: destination.trim()
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to clone model');
    }

    showToast(`Model cloned to '${destination.trim()}' successfully`, 'success');
    await fetchModels();
    populateModelDropdowns();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// Single delete
async function deleteSingleModel(name) {
  if (!confirm(`Are you sure you want to delete model '${name}'?`)) return;

  try {
    const response = await fetch('/api/models/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: [name] })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.errors ? err.errors[name] : 'Failed to delete model');
    }

    showToast(`Model '${name}' deleted successfully`, 'success');
    
    // If deleted model was being inspected, clear details
    if (inspectedModel && inspectedModel.name === name) {
      clearInspectedModel();
    }
    
    selectedModels.delete(name);
    updateBatchActionsUI();
    await fetchModels();
    populateModelDropdowns();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// Batch delete
async function handleBatchDelete() {
  const namesToDelete = Array.from(selectedModels);
  if (namesToDelete.length === 0) return;

  if (!confirm(`Are you sure you want to delete the ${namesToDelete.length} selected models?`)) return;

  try {
    showToast(`Starting batch delete of ${namesToDelete.length} models...`, 'info');
    
    const response = await fetch('/api/models/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: namesToDelete })
    });

    const data = await response.json();
    
    if (response.status === 207 || response.status === 200 || response.ok) {
      const successes = data.successes || [];
      const errors = data.errors || {};
      
      if (successes.length > 0) {
        showToast(`Successfully deleted ${successes.length} models`, 'success');
        successes.forEach(name => {
          selectedModels.delete(name);
          if (inspectedModel && inspectedModel.name === name) {
            clearInspectedModel();
          }
        });
      }
      
      const errorCount = Object.keys(errors).length;
      if (errorCount > 0) {
        showToast(`Failed to delete ${errorCount} models`, 'error');
      }
    }

    document.getElementById('select-all-checkbox').checked = false;
    updateBatchActionsUI();
    await fetchModels();
    populateModelDropdowns();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// --- MODEL PULL SSE ---

// --- MODEL PULL SSE ---

function handlePullModel(event) {
  event.preventDefault();

  // Prevent duplicate pulls
  if (currentEventSource) {
    showToast('A model download is already in progress', 'warning');
    return;
  }

  let modelName = document.getElementById('pull-model-name').value.trim();
  if (!modelName) return;

  // Normalize HuggingFace tags
  if (currentPullSource === 'hf') {
    if (!modelName.startsWith('hf.co/')) {
      if (modelName.includes('/')) {
        modelName = 'hf.co/' + modelName;
        document.getElementById('pull-model-name').value = modelName;
      } else {
        showToast('HuggingFace format: user/repo:quant or hf.co/user/repo:quant', 'warning');
        return;
      }
    }
  }

  const pullBtn = document.getElementById('pull-btn');
  const progressContainer = document.getElementById('pull-progress-container');
  const statusLabel = document.getElementById('pull-status-label');
  const progressBar = document.getElementById('pull-progress-bar');
  const percentText = document.getElementById('pull-percent');
  const speedText = document.getElementById('pull-speed');
  const bytesText = document.getElementById('pull-bytes');

  // Setup UI
  pullBtn.disabled = true;
  pullBtn.innerHTML = `<i class="fa-solid fa-circle-notch animate-spin"></i> PULLING`;
  progressContainer.classList.remove('hidden');
  
  statusLabel.textContent = 'INITIATING CONNECTION';
  progressBar.style.width = '0%';
  percentText.textContent = '0%';
  speedText.textContent = '-- MB/s';
  bytesText.textContent = 'Connecting...';

  // Open EventSource
  const url = `/api/models/pull?name=${encodeURIComponent(modelName)}`;
  currentEventSource = new EventSource(url);

  let lastCompleted = 0;
  let lastTime = Date.now();
  speedHistory = []; // Reset speed history

  currentEventSource.addEventListener('progress', (e) => {
    try {
      const data = JSON.parse(e.data);
      statusLabel.textContent = data.status.toUpperCase();
      
      if (data.total > 0) {
        const percent = Math.round((data.completed / data.total) * 100);
        progressBar.style.width = `${percent}%`;
        percentText.textContent = `${percent}%`;
        
        // Calculate speed
        const now = Date.now();
        const elapsed = (now - lastTime) / 1000; // seconds
        if (elapsed > 0.8) { // update speed every 800ms
          const bytesDiff = data.completed - lastCompleted;
          const speedVal = bytesDiff / elapsed; // bytes/sec
          const speedMb = speedVal / (1024 * 1024);
          speedText.textContent = `${speedMb.toFixed(2)} MB/s`;
          
          speedHistory.push(speedMb);
          if (speedHistory.length > 50) {
            speedHistory.shift();
          }
          drawSpeedGraph();
          
          lastCompleted = data.completed;
          lastTime = now;
        }

        bytesText.textContent = `${formatBytes(data.completed)} / ${formatBytes(data.total)}`;
      } else {
        // Status updates like 'pulling manifest', no total bytes yet
        progressBar.style.width = '0%';
        percentText.textContent = '0%';
        speedText.textContent = '-- MB/s';
        bytesText.textContent = 'Fetching manifest...';
      }
    } catch (err) {
      console.error('Error parsing SSE progress:', err);
    }
  });

  currentEventSource.addEventListener('error', (e) => {
    // e.data is present for named SSE "error" events from the server;
    // native EventSource connection errors have no e.data.
    const errDetail = e.data ? e.data : 'Connection error';
    const toastMsg = e.data
      ? `Pull failed: ${e.data}`
      : `Failed to pull model '${modelName}' — connection error`;
    showToast(toastMsg, 'error');
    // Also surface error text in the progress status label
    const lbl = document.getElementById('pull-status-label');
    if (lbl) lbl.textContent = `ERROR: ${errDetail.substring(0, 90)}`;
    console.error('SSE pull error:', errDetail, e);
    recordStreamFailure('model pull', `Failed to pull ${modelName}: ${errDetail}`, { model: modelName, node: activeServerLabel() });
    resetPullUI();
  });

  currentEventSource.addEventListener('success', (e) => {
    showToast(`Successfully pulled model '${modelName}'`, 'success');
    resetPullUI();
    document.getElementById('pull-model-name').value = '';
    
    // Refresh inventory and update model lists across workspace
    fetchModels().then(() => populateModelDropdowns());
  });
}

function resetPullUI() {
  if (currentEventSource) {
    currentEventSource.close();
    currentEventSource = null;
  }
  const pullBtn = document.getElementById('pull-btn');
  const progressContainer = document.getElementById('pull-progress-container');
  
  pullBtn.disabled = false;
  pullBtn.innerHTML = `<i class="fa-solid fa-download"></i> PULL`;
  progressContainer.classList.add('hidden');
  speedHistory = [];
}

function abortPullModel() {
  if (currentEventSource) {
    showToast('Model download aborted', 'info');
    resetPullUI();
    // Fetch models to reload lists
    fetchModels().then(() => populateModelDropdowns());
  }
}

function drawSpeedGraph() {
  const canvas = document.getElementById('pull-speed-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  // Set resolution of canvas matching CSS layout
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (speedHistory.length === 0) return;
  
  // Draw grid lines
  ctx.strokeStyle = 'rgba(76, 86, 106, 0.1)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    const y = (canvas.height / 3) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }
  
  const maxSpeed = Math.max(...speedHistory, 5); // Minimum y-scale of 5 MB/s
  const points = speedHistory.map((speed, index) => {
    const x = (index / Math.max(speedHistory.length - 1, 1)) * canvas.width;
    const y = canvas.height - (speed / maxSpeed) * (canvas.height - 10) - 5;
    return { x, y };
  });
  
  // Fill gradient below line
  if (points.length > 1) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, canvas.height);
    for (const pt of points) {
      ctx.lineTo(pt.x, pt.y);
    }
    ctx.lineTo(points[points.length - 1].x, canvas.height);
    ctx.closePath();
    
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grad.addColorStop(0, 'rgba(136, 192, 208, 0.2)');
    grad.addColorStop(1, 'rgba(136, 192, 208, 0.0)');
    ctx.fillStyle = grad;
    ctx.fill();
  }
  
  // Draw the speed path
  ctx.beginPath();
  ctx.strokeStyle = '#88c0d0'; // Nord cyan
  ctx.lineWidth = 1.5;
  points.forEach((pt, idx) => {
    if (idx === 0) ctx.moveTo(pt.x, pt.y);
    else ctx.lineTo(pt.x, pt.y);
  });
  ctx.stroke();
  
  // Pulsing dot at current point
  if (points.length > 0) {
    const lastPt = points[points.length - 1];
    ctx.beginPath();
    ctx.arc(lastPt.x, lastPt.y, 3, 0, 2 * Math.PI);
    ctx.fillStyle = '#81a1c1';
    ctx.fill();
    ctx.strokeStyle = '#88c0d0';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}


// --- METADATA INSPECTOR ---

async function inspectModel(name) {
  // Toggle: same model clicked while open → close
  if (openAccordionModel === name) {
    clearInspectedModel();
    return;
  }

  if (!accordionEl) return;

  const targetRow = document.getElementById(modelRowId(name));
  if (!targetRow) return;

  // Close any currently open accordion first
  if (openAccordionModel) clearInspectedModel();

  // Move accordion row to sit directly below the clicked row
  targetRow.insertAdjacentElement('afterend', accordionEl);
  accordionEl.style.display = '';
  openAccordionModel = name;

  // Re-render models to update INSPECT/CLOSE button labels
  renderModels();

  // Show loading state (elements are now in DOM)
  accordionEl.querySelector('#tab-content-text').textContent = 'Retrieving telemetry...';
  accordionEl.querySelector('#badge-format').textContent = '...';
  accordionEl.querySelector('#badge-family').textContent = '...';
  accordionEl.querySelector('#badge-quant').textContent = '...';
  accordionEl.querySelector('#badge-params').textContent = '...';
  accordionEl.querySelector('#detail-digest').textContent = '...';

  // Reset to modelfile tab
  activeDetailTab = 'modelfile';
  const tabs = ['modelfile', 'parameters', 'template', 'system', 'card'];
  tabs.forEach(t => {
    const btn = accordionEl.querySelector(`#detail-tab-${t}`);
    if (btn) btn.classList.toggle('detail-tab-active', t === 'modelfile');
  });

  try {
    const response = await fetch(`/api/models/detail?name=${encodeURIComponent(name)}`);
    if (!response.ok) throw new Error('Failed to load model details');

    inspectedModel = await response.json();
    inspectedModel.name = name;

    const details = inspectedModel.details || {};
    accordionEl.querySelector('#badge-format').textContent = (details.format || 'gguf').toUpperCase();
    accordionEl.querySelector('#badge-family').textContent = (details.family || 'unknown').toLowerCase();
    accordionEl.querySelector('#badge-quant').textContent = details.quantization_level || 'N/A';
    accordionEl.querySelector('#badge-params').textContent = details.parameter_size || 'N/A';

    const activeModelObj = models.find(m => m.name === name);
    accordionEl.querySelector('#detail-digest').textContent = activeModelObj
      ? activeModelObj.digest.substring(0, 16) + '...'
      : 'unknown';

    renderTabContent();
  } catch (error) {
    console.error(error);
    showToast(error.message, 'error');
    clearInspectedModel();
  }
}

function clearInspectedModel() {
  inspectedModel = null;
  modelCardCache = null;
  openAccordionModel = null;
  if (accordionEl) accordionEl.style.display = 'none';
  renderModels();
}

function switchDetailTab(tabName) {
  const tabs = ['modelfile', 'parameters', 'template', 'system', 'card'];
  tabs.forEach(t => {
    const btn = document.getElementById(`detail-tab-${t}`);
    if (btn) {
      btn.classList.toggle('detail-tab-active', t === tabName);
    }
  });

  activeDetailTab = tabName;
  renderTabContent();
}

function renderTabContent() {
  if (!inspectedModel) return;

  const tabContent = document.getElementById('tab-content-text');
  
  // Clear HTML rendering styles
  tabContent.className = "whitespace-pre-wrap break-all pr-8 leading-relaxed font-tech text-[11px] font-mono text-[#d8dee9]";

  switch (activeDetailTab) {
    case 'modelfile':
      tabContent.textContent = inspectedModel.modelfile || '# No Modelfile information available';
      break;
    case 'parameters':
      tabContent.textContent = inspectedModel.parameters || '# No custom parameters defined';
      break;
    case 'template':
      tabContent.textContent = inspectedModel.template || '# No template prompt defined';
      break;
    case 'system':
      tabContent.textContent = inspectedModel.system || '# No system prompt defined';
      break;
    case 'card':
      tabContent.textContent = 'Loading model card...';
      modelCardViewMode = 'safe';
      fetchModelCard(inspectedModel.name, tabContent);
      break;
  }
}

function copyTabContent() {
  const container = document.getElementById('tab-content-text');
  const text = container.innerText || container.textContent;
  if (!text || text.startsWith('Retrieving') || text.startsWith('Loading')) return;

  navigator.clipboard.writeText(text).then(() => {
    showToast('Telemetry data copied to clipboard', 'success');
  }).catch(err => {
    showToast('Failed to copy text', 'error');
  });
}


// --- PLAYGROUND CONTROLLER (v0.0.2) ---

function formatMessageContent(content, showThinking) {
  let escaped = escapeHTML(content);
  let thinkStartIdx = escaped.indexOf('&lt;think&gt;');
  if (thinkStartIdx === -1) {
    return escaped;
  }
  
  let result = '';
  let currentPos = 0;
  
  while (thinkStartIdx !== -1) {
    result += escaped.substring(currentPos, thinkStartIdx);
    const thinkEndIdx = escaped.indexOf('&lt;/think&gt;', thinkStartIdx + 12);
    
    if (thinkEndIdx !== -1) {
      const thinkingContent = escaped.substring(thinkStartIdx + 12, thinkEndIdx);
      if (showThinking) {
        result += `
<div class="think-block border-l-2 border-[#ebcb8b]/60 pl-3 py-1 my-2 text-[#ebcb8b]/70 bg-[#2e3440]/30 rounded-r text-[10px] font-mono">
  <div class="text-[9px] uppercase tracking-wider text-[#ebcb8b] font-tech mb-1"><i class="fa-solid fa-microchip animate-pulse mr-1"></i> Reasoning Process</div>
  ${thinkingContent}
</div>
`;
      }
      currentPos = thinkEndIdx + 13;
    } else {
      const thinkingContent = escaped.substring(thinkStartIdx + 12);
      if (showThinking) {
        result += `
<div class="think-block border-l-2 border-[#ebcb8b]/60 pl-3 py-1 my-2 text-[#ebcb8b]/70 bg-[#2e3440]/30 rounded-r text-[10px] font-mono">
  <div class="text-[9px] uppercase tracking-wider text-[#ebcb8b] font-tech mb-1"><i class="fa-solid fa-microchip animate-pulse mr-1"></i> Reasoning Process</div>
  ${thinkingContent}
</div>
`;
      }
      currentPos = escaped.length;
      break;
    }
    thinkStartIdx = escaped.indexOf('&lt;think&gt;', currentPos);
  }
  
  if (currentPos < escaped.length) {
    result += escaped.substring(currentPos);
  }
  
  return result;
}

function renderChatHistory() {
  const container = document.getElementById('chat-message-history');
  if (!container) return;

  const showThinking = document.getElementById('chat-toggle-thinking').checked;

  if (chatMessages.length === 0) {
    container.innerHTML = `
      <div class="chat chat-start">
        <div class="chat-image avatar">
          <div class="w-8 h-8 rounded-full border border-[#88c0d0] flex items-center justify-center bg-[#2e3440]">
            <i class="fa-solid fa-terminal text-[#88c0d0] text-xs"></i>
          </div>
        </div>
        <div class="chat-header text-[10px] text-[#4c566a] mb-1">SYSTEM // ROOT</div>
        <div class="chat-bubble bg-[#242933] border border-[#4c566a]/50 text-[#e5e9f0] leading-relaxed max-w-[85%]">
          Chat Console initialized. Select a model on the left panel, configure prompt arguments, and enter prompt query below to interface.
        </div>
      </div>
    `;
    return;
  }

  let html = '';
  chatMessages.forEach((msg, msgIndex) => {
    if (msg.role === 'system') {
      html += `
        <div class="chat chat-start animate-fade-in w-full">
          <div class="chat-image avatar">
            <div class="w-8 h-8 rounded-full border border-[#ebcb8b] flex items-center justify-center bg-[#2e3440]">
              <i class="fa-solid fa-compress text-[#ebcb8b] text-xs"></i>
            </div>
          </div>
          <div class="chat-header text-[10px] text-[#ebcb8b] mb-1 font-bold">SYSTEM // SUMMARY</div>
          <div class="chat-bubble bg-[#2e3440]/80 border-2 border-[#ebcb8b] text-[#ebcb8b] leading-relaxed max-w-[85%] whitespace-pre-wrap font-semibold">${escapeHTML(msg.content)}</div>
        </div>
      `;
    } else if (msg.role === 'user') {
      let imgHTML = '';
      if (msg.images && msg.images.length > 0) {
        imgHTML = '<div class="flex flex-wrap gap-2 mt-2">';
        msg.images.forEach(img => {
          const src = img.startsWith('data:') ? img : `data:image/jpeg;base64,${img}`;
          imgHTML += `<img src="${src}" class="w-24 h-24 object-cover rounded border border-[#4c566a] hover:scale-105 transition-transform duration-200 cursor-pointer" onclick="viewFullImage('${src}')" />`;
        });
        imgHTML += '</div>';
      }
      html += `
        <div class="chat chat-end animate-fade-in">
          <div class="chat-header text-[10px] text-[#4c566a] mb-1">USER // DEV</div>
          <div class="chat-bubble bg-[#3b4252] border border-[#4c566a]/50 text-[#e5e9f0] leading-relaxed max-w-[85%] whitespace-pre-wrap">${escapeHTML(msg.content)}${imgHTML}</div>
        </div>
      `;
    } else {
      const formattedContent = formatMessageContent(msg.content, showThinking);
      const modelName = document.getElementById('chat-model-select').value || 'ASSISTANT';
      
      let ragHTML = '';
      if (msg.ragSources && msg.ragSources.length > 0) {
        ragHTML = `
          <div class="mb-2.5 border border-[#4c566a]/40 rounded-lg overflow-hidden bg-[#2e3440]/40 text-xs text-[#d8dee9]">
            <details class="group">
              <summary class="flex items-center justify-between p-2 cursor-pointer bg-[#2e3440]/60 hover:bg-[#3b4252] transition-colors select-none font-tech text-[10px] uppercase text-[#88c0d0]">
                <span class="flex items-center gap-1.5 font-bold">
                  <i class="fa-solid fa-file-shield text-[10px]"></i>
                  Retrieved ${msg.ragSources.length} Context Chunks
                </span>
                <i class="fa-solid fa-chevron-down text-[8px] transition-transform group-open:rotate-180"></i>
              </summary>
              <div class="p-2.5 space-y-2 border-t border-[#4c566a]/20 max-h-60 overflow-y-auto scrollbar-thin">
        `;
        msg.ragSources.forEach((src) => {
          const scorePercent = (src.score * 100).toFixed(0);
          ragHTML += `
            <div class="bg-[#161820]/40 border border-[#4c566a]/15 rounded p-2 text-[11px] leading-relaxed">
              <div class="flex items-center justify-between mb-1 text-[9px] text-[#4c566a] font-mono">
                <span class="truncate max-w-[70%]"><i class="fa-regular fa-file text-[#88c0d0]/70"></i> ${escapeHTML(src.document_name)} (Chunk #${src.chunk_index})</span>
                <span class="bg-[#a3be8c]/15 text-[#a3be8c] border border-[#a3be8c]/35 rounded px-1 font-bold">${scorePercent}% Match</span>
              </div>
              <div class="text-[#d8dee9]/90 italic font-sans whitespace-pre-wrap select-text">"${escapeHTML(src.content)}"</div>
            </div>
          `;
        });
        ragHTML += `
              </div>
            </details>
          </div>
        `;
      }

      html += `
        <div class="chat chat-start animate-fade-in">
          <div class="chat-image avatar">
            <div class="w-8 h-8 rounded-full border border-[#88c0d0] flex items-center justify-center bg-[#2e3440]">
              <i class="fa-solid fa-terminal text-[#88c0d0] text-xs"></i>
            </div>
          </div>
          <div class="chat-header text-[10px] text-[#4c566a] mb-1 flex items-center gap-2">
            <span>${modelName.toUpperCase()}</span>
            <button id="copy-msg-${msgIndex}" onclick="copyMessageToClipboard(${msgIndex})"
              title="Copy response"
              class="ml-1 opacity-30 hover:opacity-100 transition-opacity text-[#88c0d0] cursor-pointer text-[10px]">
              <i class="fa-regular fa-copy"></i>
            </button>
          </div>
          <div class="chat-bubble bg-[#242933] border border-[#4c566a]/50 text-[#e5e9f0] leading-relaxed max-w-[85%] whitespace-pre-wrap">${ragHTML}${formattedContent}</div>
        </div>
      `;
    }
  });

  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
  updateContextVisualizer();
}

function updateContextVisualizer() {
  const visualizer = document.getElementById('chat-context-visualizer');
  if (!visualizer) return;
  
  const sysPromptEl = document.getElementById('chat-system-prompt');
  const sysPrompt = sysPromptEl ? sysPromptEl.value || '' : '';
  
  const ctxLimitEl = document.getElementById('chat-ctx-limit');
  const ctxLimit = ctxLimitEl ? parseInt(ctxLimitEl.value) || 2048 : 2048;
  
  const sysTokens = Math.ceil(sysPrompt.length / 3.9);
  
  let msgTokens = 0;
  chatMessages.forEach(msg => {
    msgTokens += Math.ceil(msg.content.length / 3.9);
    if (msg.images && msg.images.length > 0) {
      msgTokens += msg.images.length * 150;
    }
  });
  
  const totalUsed = sysTokens + msgTokens;
  const sysPercent = (sysTokens / ctxLimit) * 100;
  const msgPercent = (msgTokens / ctxLimit) * 100;
  const totalPercent = Math.min((totalUsed / ctxLimit) * 100, 100);
  
  const usedTokensEl = document.getElementById('ctx-used-tokens');
  const totalTokensEl = document.getElementById('ctx-total-tokens');
  const percentEl = document.getElementById('ctx-percent');
  
  if (usedTokensEl) usedTokensEl.textContent = totalUsed;
  if (totalTokensEl) totalTokensEl.textContent = ctxLimit;
  if (percentEl) percentEl.textContent = `${Math.round(totalPercent)}%`;
  
  const sysBar = document.getElementById('ctx-sys-bar');
  const msgBar = document.getElementById('ctx-msg-bar');
  const warningText = document.getElementById('ctx-warning-text');
  
  if (sysBar) sysBar.style.width = `${Math.min(sysPercent, 100)}%`;
  if (msgBar) msgBar.style.width = `${Math.min(msgPercent, 100 - sysPercent)}%`;
  
  if (totalUsed >= ctxLimit * 0.9) {
    if (percentEl) percentEl.className = 'font-bold text-[#bf616a]';
    if (warningText) warningText.classList.remove('hidden');
  } else if (totalUsed >= ctxLimit * 0.75) {
    if (percentEl) percentEl.className = 'font-bold text-[#ebcb8b]';
    if (warningText) warningText.classList.add('hidden');
  } else {
    if (percentEl) percentEl.className = 'font-bold text-[#88c0d0]';
    if (warningText) warningText.classList.add('hidden');
  }
}

function resetChatSession() {
  activeChatId = null;
  localStorage.removeItem('active-chat-id');
  chatMessages = [];
  renderChatHistory();
  renderChatSessions();
  const activeTitle = document.getElementById('chat-session-active-title');
  if (activeTitle) {
    activeTitle.textContent = 'AWAITING_SESSION';
  }
  const telemetry = document.getElementById('chat-telemetry');
  if (telemetry) {
    telemetry.textContent = 'Awaiting prompt...';
    telemetry.className = 'text-[#a3be8c]';
  }
}

function checkChatShortcut(e) {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    sendChatMessage();
  }
}

function abortChatGeneration() {
  if (chatAbortController) {
    chatAbortController.abort();
    showToast('Chat generation stopped', 'warning');
  }
}

function retryLastChatPrompt() {
  if (!lastChatRetryDraft) return;
  const input = document.getElementById('chat-input-text');
  if (input) {
    input.value = lastChatRetryDraft.promptText;
    input.focus();
  }
  selectedImages = [...(lastChatRetryDraft.images || [])];
  renderImagePreviews();
  const retryBtn = document.getElementById('chat-retry-btn');
  if (retryBtn) {
    retryBtn.classList.add('hidden');
    retryBtn.classList.remove('flex');
  }
  showToast('Last failed prompt restored', 'info');
}

async function sendChatMessage() {
  if (isGeneratingChat) return;

  const model = document.getElementById('chat-model-select').value;
  if (!model) {
    showToast('Please select a model first', 'warning');
    return;
  }

  const promptText = document.getElementById('chat-input-text').value.trim();
  if (!promptText) return;
  addToPromptHistory(promptText);

  if (!activeChatId) {
    const newId = await startNewChatSession(false);
    if (!newId) return;
  } else {
    // Ensure the latest sidebar options are persisted to SQLite right as we send
    await updateActiveChatConfig();
  }

  // Clear input
  document.getElementById('chat-input-text').value = '';
  lastChatRetryDraft = {
    promptText,
    images: [...selectedImages]
  };

  const telemetry = document.getElementById('chat-telemetry');

  // Push User message
  const userMsg = { role: 'user', content: promptText };
  if (selectedImages && selectedImages.length > 0) {
    userMsg.images = [...selectedImages];
  }
  chatMessages.push(userMsg);

  // Clear selected images and update preview bar UI
  selectedImages = [];
  renderImagePreviews();
  
  // Create assistant response message slot
  const assistantMsgIndex = chatMessages.length;
  chatMessages.push({ role: 'assistant', content: '' });

  // Update UI with user message and empty assistant bubble
  renderChatHistory();

  // Set loading state
  isGeneratingChat = true;
  
  // Disable controls during inference
  const sendBtn = document.getElementById('chat-send-btn');
  const stopBtn = document.getElementById('chat-stop-btn');
  const retryBtn = document.getElementById('chat-retry-btn');
  const tempInput = document.getElementById('chat-temp');
  const ctxInput = document.getElementById('chat-ctx-limit');
  const modelSelect = document.getElementById('chat-model-select');
  const resetBtn = document.querySelector('button[onclick="resetChatSession()"]');
  const thinkingToggle = document.getElementById('chat-toggle-thinking');
  const topKInput = document.getElementById('chat-top-k');
  const topPInput = document.getElementById('chat-top-p');
  const repeatPenaltyInput = document.getElementById('chat-repeat-penalty');
  const seedInputVal = document.getElementById('chat-seed');
  const presetSelect = document.getElementById('chat-preset-select');
  const systemPromptTextarea = document.getElementById('chat-system-prompt');
  const newChatBtn = document.querySelector('button[onclick="startNewChatSession()"]');
  const deletePresetBtn = document.getElementById('delete-preset-btn');
  const chatInputText = document.getElementById('chat-input-text');
  
  const minPInput = document.getElementById('chat-min-p');
  const presencePenaltyInput = document.getElementById('chat-presence-penalty');
  const frequencyPenaltyInput = document.getElementById('chat-frequency-penalty');
  const numPredictInput = document.getElementById('chat-num-predict');
  const numGpuInput = document.getElementById('chat-num-gpu');
  const numThreadInput = document.getElementById('chat-num-thread');

  if (sendBtn) sendBtn.disabled = true;
  if (retryBtn) {
    retryBtn.classList.add('hidden');
    retryBtn.classList.remove('flex');
  }
  if (stopBtn) {
    stopBtn.classList.remove('hidden');
    stopBtn.classList.add('flex');
    stopBtn.disabled = false;
  }
  if (tempInput) tempInput.disabled = true;
  if (ctxInput) ctxInput.disabled = true;
  if (modelSelect) modelSelect.disabled = true;
  if (resetBtn) resetBtn.disabled = true;
  if (thinkingToggle) thinkingToggle.disabled = true;
  if (topKInput) topKInput.disabled = true;
  if (topPInput) topPInput.disabled = true;
  if (repeatPenaltyInput) repeatPenaltyInput.disabled = true;
  if (seedInputVal) seedInputVal.disabled = true;
  if (presetSelect) presetSelect.disabled = true;
  if (systemPromptTextarea) systemPromptTextarea.disabled = true;
  if (newChatBtn) newChatBtn.disabled = true;
  if (deletePresetBtn) deletePresetBtn.disabled = true;
  if (chatInputText) chatInputText.disabled = true;
  if (minPInput) minPInput.disabled = true;
  if (presencePenaltyInput) presencePenaltyInput.disabled = true;
  if (frequencyPenaltyInput) frequencyPenaltyInput.disabled = true;
  if (numPredictInput) numPredictInput.disabled = true;
  if (numGpuInput) numGpuInput.disabled = true;
  if (numThreadInput) numThreadInput.disabled = true;

  telemetry.textContent = 'CONNECTING TO OLLAMA PIPELINE...';
  telemetry.className = 'text-[#ebcb8b] animate-pulse';

  const tempInputVal = document.getElementById('chat-temp').value;
  const temp = (tempInputVal === '' || isNaN(parseFloat(tempInputVal))) ? 0.7 : parseFloat(tempInputVal);
  const ctxInputVal = document.getElementById('chat-ctx-limit').value;
  const ctx = (ctxInputVal === '' || isNaN(parseInt(ctxInputVal))) ? 2048 : parseInt(ctxInputVal);
  const topKInputVal = document.getElementById('chat-top-k').value;
  const topK = (topKInputVal === '' || isNaN(parseInt(topKInputVal))) ? 40 : parseInt(topKInputVal);
  const topPInputVal = document.getElementById('chat-top-p').value;
  const topP = (topPInputVal === '' || isNaN(parseFloat(topPInputVal))) ? 0.9 : parseFloat(topPInputVal);
  const repeatPenaltyInputVal = document.getElementById('chat-repeat-penalty').value;
  const repeatPenalty = (repeatPenaltyInputVal === '' || isNaN(parseFloat(repeatPenaltyInputVal))) ? 1.1 : parseFloat(repeatPenaltyInputVal);
  const seedVal = document.getElementById('chat-seed').value.trim();
  const sysPrompt = document.getElementById('chat-system-prompt').value.trim();

  const minPInputVal = document.getElementById('chat-min-p').value;
  const minP = (minPInputVal === '' || isNaN(parseFloat(minPInputVal))) ? 0.0 : parseFloat(minPInputVal);
  const presencePenaltyInputVal = document.getElementById('chat-presence-penalty').value;
  const presencePenalty = (presencePenaltyInputVal === '' || isNaN(parseFloat(presencePenaltyInputVal))) ? 0.0 : parseFloat(presencePenaltyInputVal);
  const frequencyPenaltyInputVal = document.getElementById('chat-frequency-penalty').value;
  const frequencyPenalty = (frequencyPenaltyInputVal === '' || isNaN(parseFloat(frequencyPenaltyInputVal))) ? 0.0 : parseFloat(frequencyPenaltyInputVal);
  
  const numPredictInputVal = document.getElementById('chat-num-predict').value;
  const numPredict = (numPredictInputVal === '' || isNaN(parseInt(numPredictInputVal))) ? -1 : parseInt(numPredictInputVal);
  const numGpuInputVal = document.getElementById('chat-num-gpu').value;
  const numGpu = (numGpuInputVal === '' || isNaN(parseInt(numGpuInputVal))) ? -1 : parseInt(numGpuInputVal);
  const numThreadInputVal = document.getElementById('chat-num-thread').value;
  const numThread = (numThreadInputVal === '' || isNaN(parseInt(numThreadInputVal))) ? -1 : parseInt(numThreadInputVal);
  const ragEnabled = document.getElementById('chat-rag-enabled')?.checked || false;
  const ragModel = document.getElementById('chat-rag-model-select')?.value || '';
  const ragTopK = parseInt(document.getElementById('chat-rag-top-k')?.value || '3');
  
  if (ragEnabled && !ragModel) {
    showToast('Please select a RAG Embedding Model in the sidebar settings.', 'warning');
    // Re-enable controls
    if (sendBtn) sendBtn.disabled = false;
    if (tempInput) tempInput.disabled = false;
    if (ctxInput) ctxInput.disabled = false;
    if (modelSelect) modelSelect.disabled = false;
    if (resetBtn) resetBtn.disabled = false;
    if (thinkingToggle) thinkingToggle.disabled = false;
    if (topKInput) topKInput.disabled = false;
    if (topPInput) topPInput.disabled = false;
    if (repeatPenaltyInput) repeatPenaltyInput.disabled = false;
    if (seedInputVal) seedInputVal.disabled = false;
    if (presetSelect) presetSelect.disabled = false;
    if (systemPromptTextarea) systemPromptTextarea.disabled = false;
    if (newChatBtn) newChatBtn.disabled = false;
    if (deletePresetBtn) deletePresetBtn.disabled = false;
    if (chatInputText) chatInputText.disabled = false;
    if (minPInput) minPInput.disabled = false;
    if (presencePenaltyInput) presencePenaltyInput.disabled = false;
    if (frequencyPenaltyInput) frequencyPenaltyInput.disabled = false;
    if (numPredictInput) numPredictInput.disabled = false;
    if (numGpuInput) numGpuInput.disabled = false;
    if (numThreadInput) numThreadInput.disabled = false;
    
    telemetry.textContent = 'CANCELLED';
    telemetry.className = 'text-[#ebcb8b]';
    isGeneratingChat = false;
    return;
  }

  // Create messages payload
  const messagesToSend = [...chatMessages.slice(0, -1)];
  if (sysPrompt) {
    messagesToSend.unshift({ role: 'system', content: sysPrompt });
  }

  const payload = {
    model: model,
    messages: messagesToSend,
    temperature: temp,
    num_ctx: ctx,
    chat_id: activeChatId,
    top_k: topK,
    top_p: topP,
    repeat_penalty: repeatPenalty,
    min_p: minP,
    presence_penalty: presencePenalty,
    frequency_penalty: frequencyPenalty,
    num_predict: numPredict,
    num_gpu: numGpu,
    num_thread: numThread,
    rag_enabled: ragEnabled,
    rag_embedding_model: ragModel,
    rag_top_k: ragTopK
  };
  if (seedVal) {
    payload.seed = parseInt(seedVal);
  }

  const startTime = performance.now();
  let firstTokenTime = null;
  let tokenCount = 0;
  chatAbortController = new AbortController();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: chatAbortController.signal
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Chat generation failed');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    telemetry.textContent = 'GENERATING RESPONSE...';

    let lastEvent = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith('event:')) {
          lastEvent = trimmed.substring(6).trim();
          continue;
        }

        if (trimmed.startsWith('data:')) {
          const dataStr = trimmed.substring(5).trim();
          const currentEvent = lastEvent;
          lastEvent = ''; // reset immediately
          
          if (currentEvent === 'compressed') {
            console.log('Chat was auto-compressed. Summary:', dataStr);
            showToast('Chat context auto-compressed to preserve window space', 'success');
            if (activeChatId) {
              setTimeout(() => {
                switchChatSession(activeChatId);
              }, 100);
            }
            continue;
          }

          if (currentEvent === 'rag_sources') {
            try {
              const sources = JSON.parse(dataStr);
              chatMessages[assistantMsgIndex].ragSources = sources;
              renderChatHistory();
            } catch (e) {
              console.error('Error parsing rag_sources:', e);
            }
            continue;
          }

          if (dataStr === 'stream finished') {
            break;
          }
          try {
            const data = JSON.parse(dataStr);
            if (data.message && data.message.content) {
              if (!firstTokenTime) {
                firstTokenTime = performance.now();
              }
              chatMessages[assistantMsgIndex].content += data.message.content;
              tokenCount++;
              
              if (firstTokenTime) {
                const elapsedSec = (performance.now() - firstTokenTime) / 1000;
                if (elapsedSec > 0) {
                  const tokSec = (tokenCount / elapsedSec).toFixed(1);
                  telemetry.textContent = `GENERATING // ${tokSec} TOK/SEC // ${tokenCount} TOKENS`;
                }
              }
              
              renderChatHistory();
            }
            if (data.done) {
              if (data.eval_count && data.eval_duration) {
                const evalSec = data.eval_duration / 1000000000;
                const tokSec = (data.eval_count / evalSec).toFixed(1);
                telemetry.textContent = `COMPLETED // ${tokSec} TOK/SEC // ${data.eval_count} TOKENS`;
              } else if (firstTokenTime) {
                const elapsedSec = (performance.now() - firstTokenTime) / 1000;
                const tokSec = (tokenCount / elapsedSec).toFixed(1);
                telemetry.textContent = `COMPLETED // ${tokSec} TOK/SEC // ${tokenCount} TOKENS`;
              } else {
                telemetry.textContent = 'COMPLETED';
              }
              telemetry.className = 'text-[#a3be8c]';
              lastChatRetryDraft = null;
            }
          } catch (e) {
            console.error('Error parsing SSE line:', e, dataStr);
          }
        }
      }
    }

  } catch (error) {
    console.error('Chat error:', error);
    const wasAbort = error.name === 'AbortError';
    showToast(wasAbort ? 'Chat generation stopped' : error.message, wasAbort ? 'warning' : 'error');
    telemetry.textContent = wasAbort ? 'ABORTED' : 'CONNECTION FAILED';
    telemetry.className = wasAbort ? 'text-[#ebcb8b]' : 'text-[#bf616a]';
    if (!wasAbort) {
      recordStreamFailure('chat', error.message, { model, node: activeServerLabel() });
      if (retryBtn) {
        retryBtn.classList.remove('hidden');
        retryBtn.classList.add('flex');
      }
    }
    if (chatMessages[assistantMsgIndex].content === '') {
      chatMessages.pop();
      renderChatHistory();
    }
  } finally {
    chatAbortController = null;
    isGeneratingChat = false;
    if (sendBtn) sendBtn.disabled = false;
    if (stopBtn) {
      stopBtn.disabled = true;
      stopBtn.classList.add('hidden');
      stopBtn.classList.remove('flex');
    }
    if (tempInput) tempInput.disabled = false;
    if (ctxInput) ctxInput.disabled = false;
    if (modelSelect) modelSelect.disabled = false;
    if (resetBtn) resetBtn.disabled = false;
    if (thinkingToggle) thinkingToggle.disabled = false;
    if (topKInput) topKInput.disabled = false;
    if (topPInput) topPInput.disabled = false;
    if (repeatPenaltyInput) repeatPenaltyInput.disabled = false;
    if (seedInputVal) seedInputVal.disabled = false;
    if (presetSelect) presetSelect.disabled = false;
    if (systemPromptTextarea) systemPromptTextarea.disabled = false;
    if (newChatBtn) newChatBtn.disabled = false;
    if (minPInput) minPInput.disabled = false;
    if (presencePenaltyInput) presencePenaltyInput.disabled = false;
    if (frequencyPenaltyInput) frequencyPenaltyInput.disabled = false;
    if (numPredictInput) numPredictInput.disabled = false;
    if (numGpuInput) numGpuInput.disabled = false;
    if (numThreadInput) numThreadInput.disabled = false;
    if (presetSelect && presetSelect.value && deletePresetBtn) {
      deletePresetBtn.disabled = false;
    }
    if (chatInputText) {
      chatInputText.disabled = false;
      chatInputText.focus();
    }
  }
}

// --- MODEL BUILDER CONTROLLER (v0.0.2) ---

function generateModelfilePreview() {
  const baseModel = document.getElementById('builder-base-select').value;
  const temp = document.getElementById('builder-temp').value;
  const ctx = document.getElementById('builder-ctx-select').value;
  const stop = document.getElementById('builder-stop-input').value.trim();
  const system = document.getElementById('builder-system-input').value.trim();
  const templateVal = document.getElementById('builder-template-input').value.trim();

  const mergeEnable = document.getElementById('builder-merge-enable').checked;
  const mergeMethod = document.getElementById('builder-merge-method').value;
  const mergeModel = document.getElementById('builder-merge-model').value.trim();
  const mergeRatio = document.getElementById('builder-merge-ratio').value.trim();

  let modelfile = "";

  // Merge recipe details as documented metadata comments
  if (mergeEnable) {
    modelfile += `# MERGE_METHOD: ${mergeMethod}\n`;
    if (mergeModel) modelfile += `# MERGE_MODEL: ${mergeModel}\n`;
    if (mergeRatio) modelfile += `# MERGE_RATIO: ${mergeRatio}\n`;
    modelfile += `\n`;
  }

  modelfile += `FROM ${baseModel || 'base-model-placeholder'}\n\n`;
  modelfile += `# SET GENERATION PARAMETERS\n`;
  modelfile += `PARAMETER temperature ${temp}\n`;
  modelfile += `PARAMETER num_ctx ${ctx}\n`;
  
  if (stop) {
    modelfile += `PARAMETER stop "${stop}"\n`;
  }

  // Add templates
  if (templateVal) {
    modelfile += `\n# CUSTOM PROMPT TEMPLATE\n`;
    modelfile += `TEMPLATE """${templateVal}"""\n`;
  }

  // Add LoRA adapters
  const adapterInputs = document.querySelectorAll('.builder-adapter-input');
  let adapterLines = "";
  adapterInputs.forEach(input => {
    const val = input.value.trim();
    if (val) {
      adapterLines += `ADAPTER ${val}\n`;
    }
  });
  if (adapterLines) {
    modelfile += `\n# LORA ADAPTERS\n${adapterLines}`;
  }
  
  if (system) {
    modelfile += `\n# SET CUSTOM SYSTEM DIRECTIVE\n`;
    modelfile += `SYSTEM """${system}"""\n`;
  }

  document.getElementById('builder-modelfile-preview').textContent = modelfile;
}

function addAdapterField() {
  const container = document.getElementById('builder-adapters-container');
  if (!container) return;

  const div = document.createElement('div');
  div.className = 'flex items-center gap-1.5';
  
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'input input-xs input-bordered bg-[#2e3440]/60 border-[#4c566a] font-mono text-[10px] w-full focus:outline-none builder-adapter-input';
  input.placeholder = 'e.g. /path/to/adapter-or-name';
  input.oninput = generateModelfilePreview;

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn btn-xs btn-error btn-ghost p-1 h-auto min-h-0 text-[#bf616a] hover:bg-[#bf616a]/20';
  removeBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
  removeBtn.onclick = function() {
    div.remove();
    generateModelfilePreview();
  };

  div.appendChild(input);
  div.appendChild(removeBtn);
  container.appendChild(div);
  
  generateModelfilePreview();
}

function toggleMergeInputs() {
  const checkbox = document.getElementById('builder-merge-enable');
  const inputsDiv = document.getElementById('builder-merge-inputs');
  if (checkbox && inputsDiv) {
    if (checkbox.checked) {
      inputsDiv.classList.remove('hidden');
    } else {
      inputsDiv.classList.add('hidden');
    }
  }
}

async function onBaseModelChange() {
  const baseSelect = document.getElementById('builder-base-select');
  if (!baseSelect) return;
  const baseModel = baseSelect.value;
  if (!baseModel) {
    // Reset/clear preview
    document.getElementById('builder-system-input').value = "";
    document.getElementById('builder-template-input').value = "";
    document.getElementById('builder-temp').value = "0.7";
    document.getElementById('builder-temp-value').textContent = "0.7";
    document.getElementById('builder-ctx-select').value = "2048";
    document.getElementById('builder-stop-input').value = "";
    generateModelfilePreview();
    return;
  }

  // Clear inputs first or set defaults before fetching
  document.getElementById('builder-system-input').value = "";
  document.getElementById('builder-template-input').value = "";
  document.getElementById('builder-temp').value = "0.7";
  document.getElementById('builder-temp-value').textContent = "0.7";
  document.getElementById('builder-ctx-select').value = "2048";
  document.getElementById('builder-stop-input').value = "";

  try {
    const response = await fetch(`/api/models/detail?name=${encodeURIComponent(baseModel)}`);
    if (!response.ok) {
      console.error('Failed to fetch model details', response.statusText);
      generateModelfilePreview();
      return;
    }
    const data = await response.json();
    
    // Populate templates
    if (data.system) {
      document.getElementById('builder-system-input').value = data.system.trim();
    }
    if (data.template) {
      document.getElementById('builder-template-input').value = data.template.trim();
    }

    // Parse parameters
    if (data.parameters) {
      const lines = data.parameters.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2) {
          const key = parts[0].toLowerCase();
          let val = parts.slice(1).join(' ');
          
          if (key === 'temperature') {
            const parsedTemp = parseFloat(val);
            if (!isNaN(parsedTemp)) {
              document.getElementById('builder-temp').value = parsedTemp;
              document.getElementById('builder-temp-value').textContent = parsedTemp;
            }
          } else if (key === 'num_ctx') {
            const parsedCtx = parseInt(val, 10);
            if (!isNaN(parsedCtx)) {
              const ctxSelect = document.getElementById('builder-ctx-select');
              let found = false;
              for (let i = 0; i < ctxSelect.options.length; i++) {
                if (parseInt(ctxSelect.options[i].value, 10) === parsedCtx) {
                  ctxSelect.value = parsedCtx.toString();
                  found = true;
                  break;
                }
              }
              if (!found) {
                const opt = document.createElement('option');
                opt.value = parsedCtx.toString();
                opt.textContent = `${parsedCtx} tokens`;
                ctxSelect.appendChild(opt);
                ctxSelect.value = parsedCtx.toString();
              }
            }
          } else if (key === 'stop') {
            // Remove quotes if present
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.substring(1, val.length - 1);
            }
            document.getElementById('builder-stop-input').value = val;
          }
        }
      }
    }
  } catch (err) {
    console.error('Error fetching model details:', err);
  }

  // Regenerate preview
  generateModelfilePreview();
}

async function buildCustomModel() {
  if (isBuildingModel) return;

  const base = document.getElementById('builder-base-select').value;
  if (!base) {
    showToast('Select a base model recipe', 'warning');
    return;
  }

  const name = document.getElementById('builder-name-input').value.trim().toLowerCase();
  if (!name || !/^[a-z0-9-_.:]+$/.test(name)) {
    showToast('Enter a valid, URL-safe alphanumeric name', 'warning');
    return;
  }

  const modelfile = document.getElementById('builder-modelfile-preview').textContent;
  const logBox = document.getElementById('compiler-log-box');
  const indicator = document.getElementById('compiler-indicator');
  const buildBtn = document.getElementById('builder-compile-btn');
  const cancelBtn = document.getElementById('builder-cancel-btn');

  // Lock UI
  isBuildingModel = true;
  buildAbortController = new AbortController();
  buildBtn.disabled = true;
  buildBtn.innerHTML = `<i class="fa-solid fa-circle-notch animate-spin mr-1"></i> COMPILING...`;
  if (cancelBtn) {
    cancelBtn.classList.remove('hidden');
    cancelBtn.disabled = false;
  }
  indicator.className = 'h-2 w-2 rounded-full bg-[#ebcb8b] animate-pulse'; // Amber warning pulse
  
  logBox.innerHTML = `<div class="text-[#88c0d0]">CONNECTING TO COMPILER PIPELINE...</div>`;

  try {
    const response = await fetch('/api/models/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, modelfile }),
      signal: buildAbortController.signal
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Build failed to initiate');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;

        if (line.startsWith('data:')) {
          const dataStr = line.substring(5).trim();
          
          if (dataStr === 'stream finished') {
            break;
          }
          
          try {
            const parsed = JSON.parse(dataStr);
            if (parsed.status) {
              const uppercaseStatus = parsed.status.toUpperCase();
              let logClass = 'text-[#e5e9f0]';
              
              if (uppercaseStatus.includes('SUCCESS') || uppercaseStatus.includes('COMPLETE')) {
                logClass = 'text-[#a3be8c] font-bold';
              } else if (uppercaseStatus.includes('ERR') || uppercaseStatus.includes('FAIL')) {
                logClass = 'text-[#bf616a] font-bold';
              }
              
              logBox.insertAdjacentHTML('beforeend', `<div class="${logClass}">>> ${uppercaseStatus}</div>`);
              logBox.scrollTop = logBox.scrollHeight;
            }
          } catch(e) {
            console.error('Failed to parse create model log chunk', e);
          }
        }
      }
    }

    logBox.insertAdjacentHTML('beforeend', `<div class="text-[#a3be8c] font-bold mt-2">>> COMPILATION COMPLETE // MODEL '${name}' IS REGISTERED</div>`);
    indicator.className = 'h-2 w-2 rounded-full bg-[#a3be8c]'; // Green static
    showToast(`Custom model '${name}' created successfully`, 'success');
    
    // Refresh registry lists
    await fetchModels();
    populateModelDropdowns();
  } catch (error) {
    const wasAbort = error.name === 'AbortError';
    showToast(wasAbort ? 'Model build stopped' : error.message, wasAbort ? 'warning' : 'error');
    const statusText = wasAbort ? 'BUILD ABORTED BY USER' : `PIPELINE ERROR: ${error.message.toUpperCase()}`;
    logBox.insertAdjacentHTML('beforeend', `<div class="${wasAbort ? 'text-[#ebcb8b]' : 'text-[#bf616a]'} font-bold mt-2">>> ${escapeHTML(statusText)}</div>`);
    indicator.className = `h-2 w-2 rounded-full ${wasAbort ? 'bg-[#ebcb8b]' : 'bg-[#bf616a]'}`;
    if (!wasAbort) {
      recordStreamFailure('model build', error.message, { model: name, node: activeServerLabel() });
    }
  } finally {
    buildAbortController = null;
    isBuildingModel = false;
    buildBtn.disabled = false;
    buildBtn.innerHTML = `<i class="fa-solid fa-cube mr-1"></i> COMPILE_MODEL // BUILD`;
    if (cancelBtn) {
      cancelBtn.disabled = true;
      cancelBtn.classList.add('hidden');
    }
  }
}

function cancelBuildModel() {
  if (buildAbortController) {
    buildAbortController.abort();
  }
}


// --- MEMORY STATUS CONTROLLER (v0.0.2) ---

async function fetchActiveModels() {
  const container = document.getElementById('memory-models-container');
  const spinner = document.getElementById('memory-loading-spinner');

  container.innerHTML = '';
  spinner.classList.remove('hidden');

  try {
    const response = await fetch('/api/models/active');
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to fetch loaded models');
    }

    const activeModels = await response.json();
    spinner.classList.add('hidden');

    if (!activeModels || activeModels.length === 0) {
      container.innerHTML = `
        <div class="col-span-full text-center py-16 text-[#4c566a] border border-dashed border-[#4c566a]/40 rounded-xl">
          <i class="fa-solid fa-microchip text-2xl mb-2 animate-pulse"></i>
          <p class="font-tech text-xs uppercase tracking-widest">Memory Idle</p>
          <p class="text-[10px] mt-1 max-w-sm mx-auto">No LLM parameters are currently mapped into RAM or GPU VRAM. Active models are automatically loaded upon first inference.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = activeModels.map(model => {
      // Calculate GPU VRAM ratio
      const totalBytes = model.size;
      const vramBytes = model.size_vram;
      const offloadRatio = totalBytes > 0 ? (vramBytes / totalBytes) * 100 : 0;
      
      const vramFormatted = formatBytes(vramBytes);
      const systemBytes = totalBytes - vramBytes;
      const systemFormatted = formatBytes(systemBytes);
      
      let offloadLabel = '';
      let progressColorClass = 'bg-gradient-to-r from-[#81a1c1] to-[#88c0d0]'; // Blueish VRAM
      
      if (offloadRatio >= 99.9) {
        offloadLabel = '100% GPU (VRAM)';
        progressColorClass = 'bg-[#a3be8c]'; // Green VRAM
      } else if (offloadRatio <= 0.1) {
        offloadLabel = '100% CPU (SYSTEM)';
        progressColorClass = 'bg-[#bf616a]'; // Red System RAM
      } else {
        offloadLabel = `${offloadRatio.toFixed(1)}% GPU / ${(100 - offloadRatio).toFixed(1)}% CPU`;
      }

      // Expires at countdown
      const expiresAt = new Date(model.expires_at);
      const diffMs = expiresAt - Date.now();
      const diffMinutes = Math.max(0, Math.round(diffMs / 1000 / 60));

      return `
        <div class="p-4 border border-[#4c566a]/60 bg-[#242933]/40 rounded-xl flex flex-col justify-between gap-4 font-mono text-xs">
          <div>
            <div class="flex justify-between items-start">
              <div>
                <h3 class="font-bold text-sm text-[#e5e9f0] truncate max-w-[200px]">${model.name}</h3>
                <span class="badge badge-outline border-[#4c566a] text-[#81a1c1] text-[9px] mt-1 font-mono">${(model.details && model.details.parameter_size) || 'N/A'}</span>
              </div>
              <button onclick="unloadModel('${model.name}')" class="btn btn-xs btn-error font-tech text-[9px] gap-1">
                <i class="fa-solid fa-power-off"></i> EVICT
              </button>
            </div>

            <!-- VRAM Offload telemetry progress -->
            <div class="mt-4 space-y-1">
              <div class="flex justify-between text-[10px]">
                <span class="text-[#88c0d0]">OFFLOAD RATIO:</span>
                <span class="font-semibold text-[#e5e9f0]">${offloadLabel}</span>
              </div>
              <div class="w-full h-3.5 bg-[#1e222a] rounded overflow-hidden border border-[#4c566a]/40 p-0.5">
                <div class="h-full rounded ${progressColorClass}" style="width: ${offloadRatio.toFixed(1)}%"></div>
              </div>
              <div class="flex justify-between text-[9px] text-[#4c566a]">
                <span>VRAM: ${vramFormatted}</span>
                <span>System: ${systemFormatted}</span>
              </div>
            </div>
          </div>

          <div class="border-t border-[#4c566a]/30 pt-2 flex justify-between items-center text-[9px] text-[#4c566a]">
            <span>Total Weight: ${formatBytes(totalBytes)}</span>
            <span>Unloads in: ~${diffMinutes}m</span>
          </div>
        </div>
      `;
    }).join('');
  } catch (error) {
    showToast(error.message, 'error');
    spinner.classList.add('hidden');
    container.innerHTML = `
      <div class="col-span-full text-center py-12 text-[#bf616a] font-semibold italic text-xs">
        <i class="fa-solid fa-circle-exclamation mr-1.5"></i> ${error.message}
      </div>
    `;
  }
}

async function footerUnloadModel() {
  if (!loadedModels || loadedModels.length === 0) return;
  const names = loadedModels.map(m => m.name);
  const msg = names.length === 1
    ? `Evict "${names[0]}" from VRAM?`
    : `Evict all ${names.length} loaded models from VRAM?`;
  if (!confirm(msg)) return;
  for (const name of names) {
    await unloadModel(name);
  }
}

async function unloadModel(name) {
  try {
    const response = await fetch('/api/models/unload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Eviction pipeline failed');
    }

    showToast(`Model '${name}' evicted from VRAM memory`, 'success');
    await fetchActiveModels();
  } catch (error) {
    showToast(error.message, 'error');
  }
}


// --- UTILITIES ---

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Compare two semver strings (with optional "v" prefix and pre-release suffix).
// Returns -1 (a < b), 0 (equal), or 1 (a > b).
// Stable releases sort higher than pre-releases at the same version (semver).
function compareVersions(a, b) {
  const parse = v => {
    v = String(v).replace(/^v/, '');
    const [core, pre] = v.split(/-(.+)/); // split on first "-"
    const parts = core.split('.').map(n => parseInt(n, 10) || 0);
    return { major: parts[0]||0, minor: parts[1]||0, patch: parts[2]||0, pre: pre || null };
  };
  const av = parse(a), bv = parse(b);
  for (const k of ['major', 'minor', 'patch']) {
    if (av[k] > bv[k]) return 1;
    if (av[k] < bv[k]) return -1;
  }
  // Same numeric version: stable (no pre) > pre-release
  if (!av.pre && bv.pre) return 1;
  if (av.pre && !bv.pre) return -1;
  if (av.pre && bv.pre) return av.pre < bv.pre ? -1 : av.pre > bv.pre ? 1 : 0;
  return 0;
}

function escapeHTML(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function sanitizeExternalHTML(html) {
  const template = document.createElement('template');
  template.innerHTML = html || '';

  template.content.querySelectorAll('script, iframe, object, embed, form, input, button, textarea, select, option, meta, base, link').forEach(el => el.remove());

  const isSafeUrl = (rawValue) => {
    const value = (rawValue || '').trim();
    if (!value || value.startsWith('#') || value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) {
      return true;
    }
    try {
      const parsed = new URL(value, window.location.origin);
      return ['http:', 'https:', 'mailto:'].includes(parsed.protocol);
    } catch (_) {
      return false;
    }
  };

  const elements = template.content.querySelectorAll('*');
  elements.forEach(el => {
    Array.from(el.attributes).forEach(attr => {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      if (name.startsWith('on') || name === 'srcdoc' || name === 'style') {
        el.removeAttribute(attr.name);
        return;
      }
      if (['href', 'src', 'xlink:href', 'poster', 'action', 'formaction'].includes(name) && !isSafeUrl(value)) {
        el.removeAttribute(attr.name);
      }
    });

    if (el.tagName.toLowerCase() === 'a') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  });

  return template.innerHTML;
}

// --- RECENT CHATS CONTROLLERS (v0.0.3) ---

async function fetchSavedChats() {
  try {
    const response = await fetch('/api/chats');
    if (!response.ok) throw new Error('Failed to fetch chat sessions');
    chatSessions = await response.json();
    renderChatSessions();

    // Restore active chat session if saved
    const savedChatId = localStorage.getItem('active-chat-id');
    if (savedChatId && !activeChatId) {
      const idVal = parseInt(savedChatId);
      if (chatSessions.some(c => c.id === idVal)) {
        await switchChatSession(idVal);
      }
    }
  } catch (error) {
    console.error(error);
    showToast('Failed to load chat history', 'error');
  }
}

function renderChatSessions() {
  const container = document.getElementById('chat-sessions-list');
  if (!container) return;

  if (chatSessions.length === 0) {
    container.innerHTML = `
      <div class="text-center py-8 text-[#4c566a] italic text-xs">
        No active chat sessions.
      </div>
    `;
    return;
  }

  container.innerHTML = chatSessions.map(chat => {
    const isActive = chat.id === activeChatId;
    const activeBorder = isActive 
      ? 'border-[#88c0d0] bg-[#3b4252]/40 shadow-sm shadow-[#88c0d0]/10 text-[#88c0d0]' 
      : 'border-[#4c566a]/30 hover:border-[#4c566a]/70 text-[#e5e9f0]';
    
    // Formatting date
    let dateStr = '';
    if (chat.created_at) {
      try {
        const d = new Date(chat.created_at);
        dateStr = d.toLocaleTimeString(undefined, {hour: '2-digit', minute:'2-digit'});
      } catch(e) {
        dateStr = chat.created_at;
      }
    }

    return `
      <div class="p-2 border rounded-lg flex items-center justify-between gap-2 transition-all cursor-pointer ${activeBorder} group" onclick="switchChatSession(${chat.id})">
        <div class="flex-1 min-w-0">
          <h3 class="font-bold text-xs truncate group-hover:text-[#88c0d0] transition-colors">${escapeHTML(chat.title)}</h3>
          <p class="text-[9px] font-mono text-[#4c566a] truncate flex justify-between gap-1 mt-0.5">
            <span class="truncate">${escapeHTML(chat.model)}</span>
            <span class="shrink-0">${dateStr}</span>
          </p>
        </div>
        <button onclick="deleteChatSession(${chat.id}, event)" class="btn btn-ghost btn-xs p-1 text-[#bf616a] opacity-0 group-hover:opacity-100 transition-opacity" title="Delete Session">
          <i class="fa-solid fa-trash-can text-[10px]"></i>
        </button>
      </div>
    `;
  }).join('');
}

async function startNewChatSession(showFeedback = true) {
  const model = document.getElementById('chat-model-select').value;
  if (!model) {
    if (showFeedback) showToast('Please select a model first to start a chat', 'warning');
    return null;
  }

  const title = `Chat // ${new Date().toLocaleTimeString(undefined, {hour: '2-digit', minute:'2-digit', second:'2-digit'})}`;
  const sysPrompt = document.getElementById('chat-system-prompt').value.trim();
  const tempInputVal = document.getElementById('chat-temp').value;
  const temp = (tempInputVal === '' || isNaN(parseFloat(tempInputVal))) ? 0.7 : parseFloat(tempInputVal);
  const ctxInputVal = document.getElementById('chat-ctx-limit').value;
  const ctx = (ctxInputVal === '' || isNaN(parseInt(ctxInputVal))) ? 2048 : parseInt(ctxInputVal);
  const topKInputVal = document.getElementById('chat-top-k').value;
  const topK = (topKInputVal === '' || isNaN(parseInt(topKInputVal))) ? 40 : parseInt(topKInputVal);
  const topPInputVal = document.getElementById('chat-top-p').value;
  const topP = (topPInputVal === '' || isNaN(parseFloat(topPInputVal))) ? 0.9 : parseFloat(topPInputVal);
  const repeatPenaltyInputVal = document.getElementById('chat-repeat-penalty').value;
  const repeatPenalty = (repeatPenaltyInputVal === '' || isNaN(parseFloat(repeatPenaltyInputVal))) ? 1.1 : parseFloat(repeatPenaltyInputVal);
  const seedInputVal = document.getElementById('chat-seed').value.trim();
  const seed = seedInputVal ? parseInt(seedInputVal) : null;

  const minPInputVal = document.getElementById('chat-min-p').value;
  const minP = (minPInputVal === '' || isNaN(parseFloat(minPInputVal))) ? 0.0 : parseFloat(minPInputVal);
  const presencePenaltyInputVal = document.getElementById('chat-presence-penalty').value;
  const presencePenalty = (presencePenaltyInputVal === '' || isNaN(parseFloat(presencePenaltyInputVal))) ? 0.0 : parseFloat(presencePenaltyInputVal);
  const frequencyPenaltyInputVal = document.getElementById('chat-frequency-penalty').value;
  const frequencyPenalty = (frequencyPenaltyInputVal === '' || isNaN(parseFloat(frequencyPenaltyInputVal))) ? 0.0 : parseFloat(frequencyPenaltyInputVal);
  
  const numPredictInputVal = document.getElementById('chat-num-predict').value;
  const numPredict = (numPredictInputVal === '' || isNaN(parseInt(numPredictInputVal))) ? -1 : parseInt(numPredictInputVal);
  const numGpuInputVal = document.getElementById('chat-num-gpu').value;
  const numGpu = (numGpuInputVal === '' || isNaN(parseInt(numGpuInputVal))) ? -1 : parseInt(numGpuInputVal);
  const numThreadInputVal = document.getElementById('chat-num-thread').value;
  const numThread = (numThreadInputVal === '' || isNaN(parseInt(numThreadInputVal))) ? -1 : parseInt(numThreadInputVal);

  try {
    const response = await fetch('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: title,
        model: model,
        system_prompt: sysPrompt,
        temperature: temp,
        num_ctx: ctx,
        top_k: topK,
        top_p: topP,
        repeat_penalty: repeatPenalty,
        seed: seed,
        min_p: minP,
        presence_penalty: presencePenalty,
        frequency_penalty: frequencyPenalty,
        num_predict: numPredict,
        num_gpu: numGpu,
        num_thread: numThread
      })
    });

    if (!response.ok) {
      throw new Error('Failed to create chat session');
    }

    const data = await response.json();
    activeChatId = data.id;
    localStorage.setItem('active-chat-id', data.id);
    chatMessages = [];
    
    if (showFeedback) {
      showToast('New chat session initialized', 'success');
    }

    await fetchSavedChats();
    
    document.getElementById('chat-session-active-title').textContent = data.title.toUpperCase();
    renderChatHistory();
    
    return data.id;
  } catch (error) {
    showToast(error.message, 'error');
    return null;
  }
}

async function switchChatSession(id) {
  activeChatId = id;
  localStorage.setItem('active-chat-id', id || '');
  renderChatSessions();

  if (!id) {
    document.getElementById('chat-session-active-title').textContent = 'AWAITING_SESSION';
    resetChatSession();
    return;
  }

  try {
    const response = await fetch(`/api/chats/${id}`);
    if (!response.ok) throw new Error('Failed to load chat history');
    
    const messages = await response.json();
    chatMessages = messages.map(msg => ({
      role: msg.role,
      content: msg.content,
      images: msg.images || []
    }));

    const chat = chatSessions.find(c => c.id === id);
    if (chat) {
      document.getElementById('chat-session-active-title').textContent = chat.title.toUpperCase();
      document.getElementById('chat-model-select').value = chat.model;
      document.getElementById('chat-system-prompt').value = chat.system_prompt || '';
      document.getElementById('chat-temp').value = chat.temperature;
      document.getElementById('chat-temp-value').textContent = chat.temperature;
      document.getElementById('chat-ctx-limit').value = chat.num_ctx;
      
      // Load top_k, top_p, repeat_penalty, seed
      const topK = chat.top_k !== undefined ? chat.top_k : 40;
      const topP = chat.top_p !== undefined ? chat.top_p : 0.9;
      const repeatPenalty = chat.repeat_penalty !== undefined ? chat.repeat_penalty : 1.1;
      const seed = chat.seed !== undefined && chat.seed !== null ? chat.seed : '';
      const minP = chat.min_p !== undefined ? chat.min_p : 0.0;
      const presencePenalty = chat.presence_penalty !== undefined ? chat.presence_penalty : 0.0;
      const frequencyPenalty = chat.frequency_penalty !== undefined ? chat.frequency_penalty : 0.0;
      const numPredict = chat.num_predict !== undefined ? chat.num_predict : -1;
      const numGpu = chat.num_gpu !== undefined ? chat.num_gpu : -1;
      const numThread = chat.num_thread !== undefined ? chat.num_thread : -1;

      document.getElementById('chat-top-k').value = topK;
      document.getElementById('chat-top-k-value').textContent = topK;
      document.getElementById('chat-top-p').value = topP;
      document.getElementById('chat-top-p-value').textContent = parseFloat(topP).toFixed(2);
      document.getElementById('chat-repeat-penalty').value = repeatPenalty;
      document.getElementById('chat-repeat-penalty-value').textContent = parseFloat(repeatPenalty).toFixed(2);
      document.getElementById('chat-seed').value = seed;
      
      document.getElementById('chat-min-p').value = minP;
      document.getElementById('chat-min-p-value').textContent = parseFloat(minP).toFixed(2);
      document.getElementById('chat-presence-penalty').value = presencePenalty;
      document.getElementById('chat-presence-penalty-value').textContent = parseFloat(presencePenalty).toFixed(2);
      document.getElementById('chat-frequency-penalty').value = frequencyPenalty;
      document.getElementById('chat-frequency-penalty-value').textContent = parseFloat(frequencyPenalty).toFixed(2);
      document.getElementById('chat-num-predict').value = numPredict === -1 ? '' : numPredict;
      document.getElementById('chat-num-gpu').value = numGpu === -1 ? '' : numGpu;
      document.getElementById('chat-num-thread').value = numThread === -1 ? '' : numThread;
      
      updatePresetDropdownSelection(chat.system_prompt || '');
    }

    renderChatHistory();
    
    // Clear chat telemetry info on session switch
    const telemetry = document.getElementById('chat-telemetry');
    if (telemetry) {
      telemetry.textContent = 'Session restored';
      telemetry.className = 'text-[#a3be8c]';
    }
  } catch (error) {
    console.error(error);
    showToast('Failed to load chat messages', 'error');
  }
}

async function deleteChatSession(id, event) {
  if (event) event.stopPropagation();

  if (!confirm('Are you sure you want to delete this chat session?')) return;

  try {
    const response = await fetch(`/api/chats/${id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('Failed to delete chat session');

    showToast('Chat session deleted', 'warning');

    if (activeChatId === id) {
      activeChatId = null;
      localStorage.setItem('active-chat-id', '');
      chatMessages = [];
      document.getElementById('chat-session-active-title').textContent = 'AWAITING_SESSION';
      resetChatSession();
    }

    await fetchSavedChats();
  } catch (error) {
    showToast(error.message, 'error');
  }
}


// --- PRESETS CONTROLLERS (v0.0.3) ---

async function fetchPresets() {
  try {
    const response = await fetch('/api/presets');
    if (!response.ok) throw new Error('Failed to fetch presets');
    presets = await response.json();
    populatePresetsDropdown();
  } catch (error) {
    console.error(error);
    showToast('Failed to load system presets', 'error');
  }
}

function populatePresetsDropdown() {
  const select = document.getElementById('chat-preset-select');
  if (!select) return;

  let html = '<option value="">-- Custom Prompt --</option>';
  presets.forEach(p => {
    html += `<option value="${p.id}">${escapeHTML(p.name)}</option>`;
  });
  select.innerHTML = html;

  const currentSysPrompt = document.getElementById('chat-system-prompt').value;
  updatePresetDropdownSelection(currentSysPrompt);
}

function applyPresetPrompt() {
  const select = document.getElementById('chat-preset-select');
  const presetId = select.value;
  const deleteBtn = document.getElementById('delete-preset-btn');

  if (!presetId) {
    deleteBtn.classList.add('hidden');
    return;
  }

  const preset = presets.find(p => p.id == presetId);
  if (preset) {
    document.getElementById('chat-system-prompt').value = preset.content;
    deleteBtn.classList.remove('hidden');
    
    // Automatically update active chat settings in backend if a session is currently active
    if (activeChatId) {
      updateActiveChatConfig();
    }
  }
}

function updatePresetDropdownSelection(systemPromptContent) {
  const select = document.getElementById('chat-preset-select');
  const deleteBtn = document.getElementById('delete-preset-btn');
  if (!select) return;

  const matched = presets.find(p => (p.content || '').trim() === (systemPromptContent || '').trim());
  if (matched) {
    select.value = matched.id;
    deleteBtn.classList.remove('hidden');
  } else {
    select.value = '';
    deleteBtn.classList.add('hidden');
  }
}

async function savePresetPrompt() {
  const content = document.getElementById('chat-system-prompt').value.trim();
  if (!content) {
    showToast('Cannot save an empty system prompt as preset', 'warning');
    return;
  }

  const name = prompt('Enter a name for this system prompt preset:');
  if (!name || !name.trim()) return;

  try {
    const response = await fetch('/api/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        content: content
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to save preset');
    }

    const data = await response.json();
    showToast(`Preset '${name}' saved successfully`, 'success');
    
    await fetchPresets();
    
    // Highlight/Select the newly created preset
    const select = document.getElementById('chat-preset-select');
    if (select) {
      select.value = data.id;
      document.getElementById('delete-preset-btn').classList.remove('hidden');
    }
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function deleteActivePreset() {
  const select = document.getElementById('chat-preset-select');
  const presetId = select.value;
  if (!presetId) return;

  const preset = presets.find(p => p.id == presetId);
  if (!preset) return;

  if (!confirm(`Are you sure you want to delete preset '${preset.name}'?`)) return;

  try {
    const response = await fetch(`/api/presets/${presetId}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('Failed to delete preset');

    showToast(`Preset '${preset.name}' removed`, 'warning');
    select.value = '';
    document.getElementById('delete-preset-btn').classList.add('hidden');
    
    await fetchPresets();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function updateActiveChatConfig() {
  if (!activeChatId) return;
  
  const model = document.getElementById('chat-model-select').value;
  const sysPrompt = document.getElementById('chat-system-prompt').value.trim();
  const tempInputVal = document.getElementById('chat-temp').value;
  const temp = (tempInputVal === '' || isNaN(parseFloat(tempInputVal))) ? 0.7 : parseFloat(tempInputVal);
  const ctxInputVal = document.getElementById('chat-ctx-limit').value;
  const ctx = (ctxInputVal === '' || isNaN(parseInt(ctxInputVal))) ? 2048 : parseInt(ctxInputVal);
  const topKInputVal = document.getElementById('chat-top-k').value;
  const topK = (topKInputVal === '' || isNaN(parseInt(topKInputVal))) ? 40 : parseInt(topKInputVal);
  const topPInputVal = document.getElementById('chat-top-p').value;
  const topP = (topPInputVal === '' || isNaN(parseFloat(topPInputVal))) ? 0.9 : parseFloat(topPInputVal);
  const repeatPenaltyInputVal = document.getElementById('chat-repeat-penalty').value;
  const repeatPenalty = (repeatPenaltyInputVal === '' || isNaN(parseFloat(repeatPenaltyInputVal))) ? 1.1 : parseFloat(repeatPenaltyInputVal);
  const seedInput = document.getElementById('chat-seed').value.trim();
  const seed = seedInput ? parseInt(seedInput) : null;
  
  const minPInputVal = document.getElementById('chat-min-p').value;
  const minP = (minPInputVal === '' || isNaN(parseFloat(minPInputVal))) ? 0.0 : parseFloat(minPInputVal);
  const presencePenaltyInputVal = document.getElementById('chat-presence-penalty').value;
  const presencePenalty = (presencePenaltyInputVal === '' || isNaN(parseFloat(presencePenaltyInputVal))) ? 0.0 : parseFloat(presencePenaltyInputVal);
  const frequencyPenaltyInputVal = document.getElementById('chat-frequency-penalty').value;
  const frequencyPenalty = (frequencyPenaltyInputVal === '' || isNaN(parseFloat(frequencyPenaltyInputVal))) ? 0.0 : parseFloat(frequencyPenaltyInputVal);
  
  const numPredictInputVal = document.getElementById('chat-num-predict').value;
  const numPredict = (numPredictInputVal === '' || isNaN(parseInt(numPredictInputVal))) ? -1 : parseInt(numPredictInputVal);
  const numGpuInputVal = document.getElementById('chat-num-gpu').value;
  const numGpu = (numGpuInputVal === '' || isNaN(parseInt(numGpuInputVal))) ? -1 : parseInt(numGpuInputVal);
  const numThreadInputVal = document.getElementById('chat-num-thread').value;
  const numThread = (numThreadInputVal === '' || isNaN(parseInt(numThreadInputVal))) ? -1 : parseInt(numThreadInputVal);

  const chat = chatSessions.find(c => c.id === activeChatId);
  if (chat) {
    chat.model = model;
    chat.system_prompt = sysPrompt;
    chat.temperature = temp;
    chat.num_ctx = ctx;
    chat.top_k = topK;
    chat.top_p = topP;
    chat.repeat_penalty = repeatPenalty;
    chat.seed = seed;
    chat.min_p = minP;
    chat.presence_penalty = presencePenalty;
    chat.frequency_penalty = frequencyPenalty;
    chat.num_predict = numPredict;
    chat.num_gpu = numGpu;
    chat.num_thread = numThread;
  }

  // Persist updated config in sqlite backend
  try {
    const response = await fetch(`/api/chats/${activeChatId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model,
        system_prompt: sysPrompt,
        temperature: temp,
        num_ctx: ctx,
        top_k: topK,
        top_p: topP,
        repeat_penalty: repeatPenalty,
        seed: seed,
        min_p: minP,
        presence_penalty: presencePenalty,
        frequency_penalty: frequencyPenalty,
        num_predict: numPredict,
        num_gpu: numGpu,
        num_thread: numThread
      })
    });
    if (!response.ok) {
      console.error('Failed to auto-save chat configuration');
    }
  } catch (error) {
    console.error('Network error during auto-save:', error);
  }
}


// --- REGISTRY CATALOG CONTROLLERS (v0.0.3) ---

// caps: 'vision' | 'embedding' | 'moe' | 'code' | 'reasoning'
// source: 'ollama' | 'hf'
const POPULAR_MODELS = [
  // ── General ──────────────────────────────────────────────────────────────
  { name:'llama3.1:8b',      source:'ollama', category:'General',     caps:[],             params:'8B',    ctx:'128K', size:'4.9 GB',  desc:"Meta's flagship instruction model with 128K context window." },
  { name:'llama3.2:3b',      source:'ollama', category:'General',     caps:[],             params:'3B',    ctx:'128K', size:'2.0 GB',  desc:"Compact Meta model, fast and capable with full 128K context." },
  { name:'mistral:7b',       source:'ollama', category:'General',     caps:[],             params:'7B',    ctx:'32K',  size:'4.1 GB',  desc:"Mistral AI's reliable dense 7B model, strong across the board." },
  { name:'qwen2.5:7b',       source:'ollama', category:'General',     caps:[],             params:'7B',    ctx:'128K', size:'4.7 GB',  desc:"Alibaba Qwen 2.5 — strong multilingual, math, and instruction following." },
  { name:'phi4:14b',         source:'ollama', category:'General',     caps:[],             params:'14B',   ctx:'16K',  size:'8.9 GB',  desc:"Microsoft Phi-4 — punches well above its weight in reasoning benchmarks." },
  { name:'phi3:3.8b',        source:'ollama', category:'Lightweight', caps:[],             params:'3.8B',  ctx:'128K', size:'2.2 GB',  desc:"Microsoft Phi-3 Mini — excellent reasoning at a tiny footprint." },
  { name:'gemma2:9b',        source:'ollama', category:'General',     caps:[],             params:'9B',    ctx:'8K',   size:'5.4 GB',  desc:"Google Gemma 2 9B — beats larger models on many benchmarks." },
  // ── Reasoning ────────────────────────────────────────────────────────────
  { name:'deepseek-r1:8b',   source:'ollama', category:'Reasoning',   caps:['reasoning'],  params:'8B',    ctx:'128K', size:'4.9 GB',  desc:"DeepSeek R1 8B — RL-tuned for long chain-of-thought reasoning." },
  { name:'deepseek-r1:14b',  source:'ollama', category:'Reasoning',   caps:['reasoning'],  params:'14B',   ctx:'128K', size:'9.0 GB',  desc:"DeepSeek R1 14B — accuracy-focused reasoning distillate from 671B." },
  { name:'deepseek-r1:32b',  source:'ollama', category:'Reasoning',   caps:['reasoning'],  params:'32B',   ctx:'128K', size:'20 GB',   desc:"DeepSeek R1 32B — near-frontier reasoning, self-verifying CoT." },
  { name:'qwq:32b',          source:'ollama', category:'Reasoning',   caps:['reasoning'],  params:'32B',   ctx:'32K',  size:'20 GB',   desc:"Qwen QwQ — deliberate thinker, competitive with o1 on math & science." },
  // ── Vision ───────────────────────────────────────────────────────────────
  { name:'gemma3:4b',        source:'ollama', category:'Vision',      caps:['vision'],     params:'4B',    ctx:'128K', size:'3.3 GB',  desc:"Google Gemma 3 multimodal — vision + text at an impressive size." },
  { name:'gemma3:12b',       source:'ollama', category:'Vision',      caps:['vision'],     params:'12B',   ctx:'128K', size:'8.1 GB',  desc:"Google Gemma 3 12B — strong vision reasoning with wide context." },
  { name:'llava:7b',         source:'ollama', category:'Vision',      caps:['vision'],     params:'7B',    ctx:'4K',   size:'4.7 GB',  desc:"The original LLaVA — vision encoder fused with Llama language model." },
  { name:'llava:13b',        source:'ollama', category:'Vision',      caps:['vision'],     params:'13B',   ctx:'4K',   size:'8.0 GB',  desc:"Larger LLaVA for improved visual reasoning tasks." },
  { name:'minicpm-v:8b',     source:'ollama', category:'Vision',      caps:['vision'],     params:'8B',    ctx:'8K',   size:'5.5 GB',  desc:"MiniCPM-V — efficient vision LLM, great at OCR and image QA." },
  { name:'moondream:1.8b',   source:'ollama', category:'Vision',      caps:['vision'],     params:'1.8B',  ctx:'2K',   size:'1.1 GB',  desc:"Tiny vision model that runs comfortably on CPU." },
  // ── Code ─────────────────────────────────────────────────────────────────
  { name:'qwen2.5-coder:7b', source:'ollama', category:'Code',        caps:['code'],       params:'7B',    ctx:'32K',  size:'4.7 GB',  desc:"Qwen 2.5 Coder 7B — strong fill-in-the-middle and repo-level reasoning." },
  { name:'qwen2.5-coder:32b',source:'ollama', category:'Code',        caps:['code'],       params:'32B',   ctx:'128K', size:'20 GB',   desc:"Qwen 2.5 Coder 32B — near-GPT-4 coding quality for local use." },
  { name:'devstral:24b',     source:'ollama', category:'Code',        caps:['code'],       params:'24B',   ctx:'128K', size:'14 GB',   desc:"Mistral Devstral — built for agentic coding tasks, 128K context." },
  { name:'codellama:7b',     source:'ollama', category:'Code',        caps:['code'],       params:'7B',    ctx:'16K',  size:'3.8 GB',  desc:"Meta's Code Llama 7B — solid code completion and infill model." },
  { name:'codegemma:7b',     source:'ollama', category:'Code',        caps:['code'],       params:'7B',    ctx:'8K',   size:'4.8 GB',  desc:"Google CodeGemma — specialized for code completion and generation." },
  // ── Embedding ─────────────────────────────────────────────────────────────
  { name:'nomic-embed-text', source:'ollama', category:'Embedding',   caps:['embedding'],  params:'137M',  ctx:'8K',   size:'274 MB',  desc:"Nomic AI text embedding — fast, high-quality, 8K context window." },
  { name:'mxbai-embed-large',source:'ollama', category:'Embedding',   caps:['embedding'],  params:'335M',  ctx:'512',  size:'670 MB',  desc:"mixedbread MTEB SOTA embedding — great for semantic search." },
  { name:'bge-m3',           source:'ollama', category:'Embedding',   caps:['embedding'],  params:'570M',  ctx:'8K',   size:'1.2 GB',  desc:"BGE-M3 — multilingual, multi-granularity retrieval embedding." },
  { name:'all-minilm:l6-v2', source:'ollama', category:'Embedding',   caps:['embedding'],  params:'23M',   ctx:'512',  size:'46 MB',   desc:"Tiny sentence transformer, blazing fast for lightweight RAG." },
  // ── Large / MoE ───────────────────────────────────────────────────────────
  { name:'mixtral:8x7b',     source:'ollama', category:'Large',       caps:['moe'],        params:'8×7B',  ctx:'32K',  size:'26 GB',   desc:"Mistral MoE — 8 experts, activates 2 per token, efficient and capable." },
  { name:'llama3.1:70b',     source:'ollama', category:'Large',       caps:[],             params:'70B',   ctx:'128K', size:'40 GB',   desc:"Meta Llama 3.1 70B — near-frontier quality for local deployment." },
  { name:'llama4:scout',     source:'ollama', category:'Large',       caps:['vision','moe'],params:'109B', ctx:'10M',  size:'67 GB',   desc:"Meta Llama 4 Scout — 17B active params, 10M ctx, vision + MoE." },
  { name:'gemma3:27b',       source:'ollama', category:'Large',       caps:['vision'],     params:'27B',   ctx:'128K', size:'17 GB',   desc:"Google Gemma 3 27B — top open-weights multimodal model." },
  // ── Lightweight ────────────────────────────────────────────────────────────
  { name:'gemma2:2b',        source:'ollama', category:'Lightweight', caps:[],             params:'2B',    ctx:'8K',   size:'1.6 GB',  desc:"Google Gemma 2 2B — surprisingly capable, runs on CPU." },
  { name:'tinyllama:1.1b',   source:'ollama', category:'Lightweight', caps:[],             params:'1.1B',  ctx:'2K',   size:'638 MB',  desc:"TinyLlama — 1.1B parameters, useful for embedded/edge use." },
  { name:'phi3.5:3.8b',      source:'ollama', category:'Lightweight', caps:[],             params:'3.8B',  ctx:'128K', size:'2.2 GB',  desc:"Phi-3.5 Mini — updated Phi with strong long-context performance." },
  // ── HuggingFace GGUF ──────────────────────────────────────────────────────
  // Note: bartowski uses org-prefix naming for models from orgs (mistralai_, google_)
  // and "Meta-" prefix for Meta models. Verified against HuggingFace repo listing.
  { name:'hf.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF:Q4_K_M',                       source:'hf', category:'General',   caps:[],            params:'8B',  ctx:'128K', size:'~5 GB',  desc:"Bartowski's Llama 3.1 8B GGUF — popular well-quantized community build." },
  { name:'hf.co/bartowski/google_gemma-3-27b-it-GGUF:Q4_K_M',                             source:'hf', category:'Vision',    caps:['vision'],    params:'27B', ctx:'128K', size:'~17 GB', desc:"Gemma 3 27B instruction-tuned GGUF with full vision support." },
  { name:'hf.co/bartowski/DeepSeek-R1-Distill-Qwen-14B-GGUF:Q4_K_M',                      source:'hf', category:'Reasoning', caps:['reasoning'], params:'14B', ctx:'64K',  size:'~9 GB',  desc:"DeepSeek R1 14B distilled into Qwen — fast reasoning at smaller scale." },
  { name:'hf.co/bartowski/mistralai_Mistral-Small-3.1-24B-Instruct-2503-GGUF:Q4_K_M',     source:'hf', category:'Vision',    caps:['vision'],    params:'24B', ctx:'128K', size:'~15 GB', desc:"Mistral Small 3.1 24B — strong multilingual vision + text model." },
  { name:'hf.co/bartowski/Qwen2.5-Coder-32B-Instruct-GGUF:Q4_K_M',                        source:'hf', category:'Code',      caps:['code'],      params:'32B', ctx:'128K', size:'~20 GB', desc:"Qwen 2.5 Coder 32B GGUF — best open-source coding model at this weight." },
];

// --- MODEL HUB STATE ---
let currentPullSource = 'ollama';
let catalogCategoryFilter = 'all';

const CAP_BADGES = {
  vision:    { label: 'VIS',    cls: 'border-[#b48ead] text-[#b48ead]', icon: 'fa-eye' },
  embedding: { label: 'EMB',    cls: 'border-[#ebcb8b] text-[#ebcb8b]', icon: 'fa-layer-group' },
  moe:       { label: 'MoE',    cls: 'border-[#d08770] text-[#d08770]', icon: 'fa-network-wired' },
  code:      { label: 'CODE',   cls: 'border-[#88c0d0] text-[#88c0d0]', icon: 'fa-code' },
  reasoning: { label: 'REASON', cls: 'border-[#a3be8c] text-[#a3be8c]', icon: 'fa-brain' },
};

const SOURCE_BADGE = {
  ollama: 'bg-[#88c0d0]/15 text-[#88c0d0] border-[#88c0d0]/40',
  hf:     'bg-[#ebcb8b]/15 text-[#ebcb8b] border-[#ebcb8b]/40',
};

function setPullSource(source) {
  currentPullSource = source;
  ['ollama', 'hf'].forEach(s => {
    const btn = document.getElementById(`pull-src-${s}`);
    if (btn) btn.classList.toggle('bench-type-btn-active', s === source);
  });
  const input = document.getElementById('pull-model-name');
  if (input) {
    input.placeholder = source === 'hf'
      ? 'e.g. hf.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF:Q4_K_M'
      : 'e.g. llama3:8b, mistral, qwen2.5:1.5b';
    input.value = '';
  }
  // Show / hide the HF compatibility notice
  const hfNote = document.getElementById('hf-compat-note');
  if (hfNote) hfNote.classList.toggle('hidden', source !== 'hf');
}

function setCatalogCategory(cat) {
  catalogCategoryFilter = cat;
  const cats = ['all', 'General', 'Reasoning', 'Vision', 'Code', 'Embedding', 'Large', 'Lightweight'];
  cats.forEach(c => {
    const id = c === 'all' ? 'cat-all' : `cat-${c}`;
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('bench-type-btn-active', c === cat);
  });
  renderCatalog();
}

function renderCatalog() {
  const grid = document.getElementById('catalog-grid');
  if (!grid) return;

  const filterText = document.getElementById('catalog-filter')?.value.toLowerCase().trim() || '';

  const filtered = POPULAR_MODELS.filter(item => {
    if (catalogCategoryFilter !== 'all' && item.category !== catalogCategoryFilter) return false;
    if (!filterText) return true;
    return item.name.toLowerCase().includes(filterText) ||
           item.category.toLowerCase().includes(filterText) ||
           item.desc.toLowerCase().includes(filterText) ||
           (item.caps || []).some(c => c.includes(filterText));
  });

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="col-span-full text-center py-6 text-[#4c566a] italic text-xs">No matching models found.</div>`;
    return;
  }

  grid.innerHTML = filtered.map(item => {
    // Installed check
    const baseName = item.name.split(':')[0].split('/').pop();
    const isInstalled = models.some(m => {
      const localBase = m.name.split(':')[0];
      return m.name === item.name || localBase === baseName || localBase === item.name.split(':')[0];
    });

    // Source badge
    const srcCls = SOURCE_BADGE[item.source] || SOURCE_BADGE.ollama;
    const srcLabel = item.source === 'hf' ? 'HF' : 'OLLAMA';

    // Display name: for long HF paths, show just the repo+quant
    let displayName = item.name;
    if (item.source === 'hf') {
      const parts = item.name.replace('hf.co/', '').split('/');
      displayName = parts.length >= 2 ? parts.slice(1).join('/') : item.name;
    }

    // Capability badges
    const capBadgesHtml = (item.caps || []).map(cap => {
      const b = CAP_BADGES[cap];
      if (!b) return '';
      return `<span class="inline-flex items-center gap-0.5 border ${b.cls} rounded px-1 text-[7px] font-mono font-bold"><i class="fa-solid ${b.icon} text-[6px]"></i>${b.label}</span>`;
    }).join('');

    // Params / ctx / size meta line
    const meta = [item.params && `${item.params}`, item.ctx && `ctx ${item.ctx}`, item.size].filter(Boolean).join(' · ');

    return `
      <div class="p-2.5 border border-[#4c566a]/30 bg-[#242933]/30 rounded-lg flex flex-col justify-between gap-1.5 hover:border-[#4c566a]/60 transition-colors cursor-default">
        <div class="flex justify-between items-start gap-1">
          <div class="min-w-0 flex-1">
            <div class="flex items-start gap-1 flex-wrap">
              <span class="font-bold text-[#e5e9f0] text-xs leading-tight break-all" title="${escapeHTML(item.name)}">${escapeHTML(displayName)}</span>
            </div>
            <div class="flex items-center gap-1 mt-0.5 flex-wrap">
              <span class="border ${srcCls} rounded px-1 text-[7px] font-mono font-bold">${srcLabel}</span>
              ${capBadgesHtml}
            </div>
            <span class="text-[9px] text-[#4c566a] block mt-0.5">${escapeHTML(meta)}</span>
          </div>
          <div class="shrink-0 ml-1">
            ${isInstalled
              ? `<span class="inline-flex items-center gap-0.5 bg-[#a3be8c]/15 border border-[#a3be8c]/40 text-[#a3be8c] text-[8px] font-mono px-1.5 py-0.5 rounded font-bold"><i class="fa-solid fa-check text-[7px]"></i>OK</span>`
              : `<button onclick="pullCatalogModel('${escapeHTML(item.name)}', '${item.source}')" class="btn btn-xs btn-outline btn-info font-tech text-[9px] px-2 py-0 h-5 min-h-0 uppercase">PULL</button>`
            }
          </div>
        </div>
        <p class="text-[9px] text-[#4c566a] leading-tight line-clamp-2">${escapeHTML(item.desc)}</p>
      </div>
    `;
  }).join('');
}

function filterCatalog() {
  renderCatalog();
}

function pullCatalogModel(name, source) {
  // Switch source toggle to match the model's origin (before setting the value,
  // because setPullSource clears the input field)
  if (source && source !== currentPullSource) {
    setPullSource(source);
  }

  // Make sure we're on the hub sub-tab so the form + progress are visible
  if (activeInventorySubtab !== 'hub') switchInventorySubtab('hub');

  const pullInput = document.getElementById('pull-model-name');
  if (!pullInput) return;
  pullInput.value = name;

  // Brief visual flash on the form
  const form = document.getElementById('pull-model-form');
  if (form) {
    form.classList.add('ring-1', 'ring-[#88c0d0]');
    setTimeout(() => form.classList.remove('ring-1', 'ring-[#88c0d0]'), 600);
  }

  // Call the pull handler directly — avoids dispatching a non-cancelable submit
  // event whose preventDefault() would be silently ignored by the browser.
  handlePullModel({ preventDefault: () => {} });
}

// handleHfPull removed — HF pulls now go through the unified Model Hub form.
// Kept as no-op stub so any stale references don't throw.
function handleHfPull(event) { if (event) event.preventDefault(); }

// --- COLLAPSIBLE LAYOUT ENGINE ---

function toggleNodeRegistry() {
  const sidebar = document.getElementById('node-registry-sidebar');
  const mainSection = document.getElementById('main-workspace-section');
  const icon = document.getElementById('toggle-registry-icon');
  
  if (!sidebar || !mainSection) return;

  const isCollapsed = sidebar.classList.contains('hidden');
  
  if (isCollapsed) {
    sidebar.classList.remove('hidden');
    mainSection.classList.replace('lg:col-span-12', 'lg:col-span-9');
    if (icon) icon.className = 'fa-solid fa-chevron-left text-xs';
    setPref('sidebar-registry-collapsed', 'false');
  } else {
    sidebar.classList.add('hidden');
    mainSection.classList.replace('lg:col-span-9', 'lg:col-span-12');
    if (icon) icon.className = 'fa-solid fa-chevron-right text-xs';
    setPref('sidebar-registry-collapsed', 'true');
  }
}

function togglePlaygroundSidebar(type) {
  const chatsSidebar = document.getElementById('playground-chats-sidebar');
  const configSidebar = document.getElementById('playground-config-sidebar');
  
  if (!chatsSidebar || !configSidebar) return;

  if (type === 'chats') {
    const isHidden = chatsSidebar.classList.contains('hidden');
    if (isHidden) {
      chatsSidebar.classList.remove('hidden');
      setPref('sidebar-chats-collapsed', 'false');
    } else {
      chatsSidebar.classList.add('hidden');
      setPref('sidebar-chats-collapsed', 'true');
    }
  } else if (type === 'config') {
    const isHidden = configSidebar.classList.contains('hidden');
    if (isHidden) {
      configSidebar.classList.remove('hidden');
      setPref('sidebar-config-collapsed', 'false');
    } else {
      configSidebar.classList.add('hidden');
      setPref('sidebar-config-collapsed', 'true');
    }
  }

  updatePlaygroundLayoutClasses();
}

function updatePlaygroundLayoutClasses() {
  const chatsSidebar = document.getElementById('playground-chats-sidebar');
  const configSidebar = document.getElementById('playground-config-sidebar');
  const leftPanel = document.getElementById('playground-left-panel');
  const toggleChatsIcon = document.getElementById('toggle-chats-icon');
  const toggleConfigIcon = document.getElementById('toggle-config-icon');

  if (!chatsSidebar || !configSidebar) return;

  const chatsHidden = chatsSidebar.classList.contains('hidden');
  const configHidden = configSidebar.classList.contains('hidden');

  if (toggleChatsIcon) {
    toggleChatsIcon.className = chatsHidden ? 'fa-solid fa-chevron-right' : 'fa-solid fa-chevron-left';
  }
  if (toggleConfigIcon) {
    toggleConfigIcon.className = configHidden ? 'fa-solid fa-chevron-right' : 'fa-solid fa-chevron-left';
  }

  // Hide the whole left panel only when both sidebars are collapsed
  if (leftPanel) {
    if (chatsHidden && configHidden) {
      leftPanel.classList.add('hidden');
    } else {
      leftPanel.classList.remove('hidden');
    }
  }
}

function initSidebarState() {
  const registryCollapsed = getPref('sidebar-registry-collapsed') === 'true';
  const chatsCollapsed = getPref('sidebar-chats-collapsed') === 'true';
  const configCollapsed = getPref('sidebar-config-collapsed') === 'true';

  if (registryCollapsed) {
    const sidebar = document.getElementById('node-registry-sidebar');
    const mainSection = document.getElementById('main-workspace-section');
    const icon = document.getElementById('toggle-registry-icon');
    if (sidebar && mainSection) {
      sidebar.classList.add('hidden');
      mainSection.classList.replace('lg:col-span-9', 'lg:col-span-12');
      if (icon) icon.className = 'fa-solid fa-chevron-right text-xs';
    }
  }

  if (chatsCollapsed) {
    const chatsSidebar = document.getElementById('playground-chats-sidebar');
    if (chatsSidebar) chatsSidebar.classList.add('hidden');
  }
  
  if (configCollapsed) {
    const configSidebar = document.getElementById('playground-config-sidebar');
    if (configSidebar) configSidebar.classList.add('hidden');
  }

  updatePlaygroundLayoutClasses();
}

// --- API SNIPPET GENERATOR ---

let activeSnippetTab = 'curl';

function openApiSnippetsModal() {
  const modal = document.getElementById('api-snippets-modal');
  if (modal) {
    modal.showModal();
    switchSnippetTab(activeSnippetTab);
  }
}

function closeApiSnippetsModal() {
  const modal = document.getElementById('api-snippets-modal');
  if (modal) {
    modal.close();
  }
}

function switchSnippetTab(format) {
  activeSnippetTab = format;
  
  const formats = ['curl', 'python', 'nodejs', 'go'];
  formats.forEach(f => {
    const btn = document.getElementById(`tab-snippet-${f}`);
    if (btn) {
      if (f === format) {
        btn.className = 'btn btn-xs btn-info font-tech text-[10px] px-2.5 py-1';
      } else {
        btn.className = 'btn btn-xs btn-neutral border-[#4c566a] font-tech text-[10px] px-2.5 py-1 text-[#d8dee9]';
      }
    }
  });
  
  const codeBlock = document.getElementById('snippet-code-block');
  if (codeBlock) {
    codeBlock.textContent = generateSnippet(format);
  }
}

function copySnippetToClipboard() {
  const codeBlock = document.getElementById('snippet-code-block');
  if (!codeBlock) return;
  
  navigator.clipboard.writeText(codeBlock.textContent)
    .then(() => {
      showToast('Snippet copied to clipboard!', 'success');
    })
    .catch(err => {
      showToast('Failed to copy snippet', 'error');
    });
}

function getCurrentPlaygroundConfig() {
  const model = document.getElementById('chat-model-select').value || 'llama3';
  const sysPrompt = document.getElementById('chat-system-prompt').value.trim();
  
  const tempInputVal = document.getElementById('chat-temp').value;
  const temp = (tempInputVal === '' || isNaN(parseFloat(tempInputVal))) ? 0.7 : parseFloat(tempInputVal);
  const ctxInputVal = document.getElementById('chat-ctx-limit').value;
  const ctx = (ctxInputVal === '' || isNaN(parseInt(ctxInputVal))) ? 2048 : parseInt(ctxInputVal);
  const topKInputVal = document.getElementById('chat-top-k').value;
  const topK = (topKInputVal === '' || isNaN(parseInt(topKInputVal))) ? 40 : parseInt(topKInputVal);
  const topPInputVal = document.getElementById('chat-top-p').value;
  const topP = (topPInputVal === '' || isNaN(parseFloat(topPInputVal))) ? 0.9 : parseFloat(topPInputVal);
  const repeatPenaltyInputVal = document.getElementById('chat-repeat-penalty').value;
  const repeatPenalty = (repeatPenaltyInputVal === '' || isNaN(parseFloat(repeatPenaltyInputVal))) ? 1.1 : parseFloat(repeatPenaltyInputVal);
  const seedInputVal = document.getElementById('chat-seed').value.trim();
  const seed = seedInputVal ? parseInt(seedInputVal) : null;
  
  const minPInputVal = document.getElementById('chat-min-p').value;
  const minP = (minPInputVal === '' || isNaN(parseFloat(minPInputVal))) ? 0.0 : parseFloat(minPInputVal);
  const presencePenaltyInputVal = document.getElementById('chat-presence-penalty').value;
  const presencePenalty = (presencePenaltyInputVal === '' || isNaN(parseFloat(presencePenaltyInputVal))) ? 0.0 : parseFloat(presencePenaltyInputVal);
  const frequencyPenaltyInputVal = document.getElementById('chat-frequency-penalty').value;
  const frequencyPenalty = (frequencyPenaltyInputVal === '' || isNaN(parseFloat(frequencyPenaltyInputVal))) ? 0.0 : parseFloat(frequencyPenaltyInputVal);
  
  const numPredictInputVal = document.getElementById('chat-num-predict').value;
  const numPredict = (numPredictInputVal === '' || isNaN(parseInt(numPredictInputVal))) ? -1 : parseInt(numPredictInputVal);
  const numGpuInputVal = document.getElementById('chat-num-gpu').value;
  const numGpu = (numGpuInputVal === '' || isNaN(parseInt(numGpuInputVal))) ? -1 : parseInt(numGpuInputVal);
  const numThreadInputVal = document.getElementById('chat-num-thread').value;
  const numThread = (numThreadInputVal === '' || isNaN(parseInt(numThreadInputVal))) ? -1 : parseInt(numThreadInputVal);

  return {
    model,
    sysPrompt,
    temp,
    ctx,
    topK,
    topP,
    repeatPenalty,
    seed,
    minP,
    presencePenalty,
    frequencyPenalty,
    numPredict,
    numGpu,
    numThread
  };
}

function getSnippetMessages(sysPrompt) {
  const msgs = chatMessages.filter(m => m.content.trim() !== '');
  
  const formattedMsgs = [];
  if (sysPrompt) {
    formattedMsgs.push({ role: 'system', content: sysPrompt });
  }
  
  if (msgs.length > 0) {
    msgs.forEach(m => {
      formattedMsgs.push({ role: m.role, content: m.content });
    });
  } else {
    formattedMsgs.push({ role: 'user', content: 'Why is the sky blue?' });
  }
  
  return formattedMsgs;
}

function getSnippetOptions(cfg) {
  const options = {
    temperature: cfg.temp,
    num_ctx: cfg.ctx,
    top_k: cfg.topK,
    top_p: cfg.topP,
    repeat_penalty: cfg.repeatPenalty,
    min_p: cfg.minP,
    presence_penalty: cfg.presencePenalty,
    frequency_penalty: cfg.frequencyPenalty
  };
  
  if (cfg.seed !== null) {
    options.seed = cfg.seed;
  }
  if (cfg.numPredict >= 0) {
    options.num_predict = cfg.numPredict;
  }
  if (cfg.numGpu >= 0) {
    options.num_gpu = cfg.numGpu;
  }
  if (cfg.numThread >= 0) {
    options.num_thread = cfg.numThread;
  }
  
  return options;
}

function generateSnippet(format) {
  const activeSrv = servers.find(s => s.isActive);
  const serverUrl = activeSrv ? activeSrv.URL : 'http://localhost:11434';
  const cfg = getCurrentPlaygroundConfig();
  const messages = getSnippetMessages(cfg.sysPrompt);
  const options = getSnippetOptions(cfg);

  if (format === 'curl') {
    const curlPayload = {
      model: cfg.model,
      messages: messages,
      options: options,
      stream: false
    };
    return `curl ${serverUrl}/api/chat -H "Content-Type: application/json" -d '${JSON.stringify(curlPayload, null, 2)}'`;
  }
  
  if (format === 'python') {
    return `import requests

url = "${serverUrl}/api/chat"
payload = {
    "model": "${cfg.model}",
    "messages": [
\${messages.map(m => \`        {"role": "\${m.role}", "content": \${JSON.stringify(m.content)}}\`).join(',\\n')}
    ],
    "options": {
\${Object.entries(options).map(([k, v]) => \`        "\${k}": \${typeof v === 'string' ? JSON.stringify(v) : v}\`).join(',\\n')}
    },
    "stream": False
}

response = requests.post(url, json=payload)
print(response.json()['message']['content'])
`;
  }
  
  if (format === 'nodejs') {
    return `const url = '${serverUrl}/api/chat';
const payload = {
  model: '${cfg.model}',
  messages: [
\${messages.map(m => \`    { role: '\${m.role}', content: \${JSON.stringify(m.content)} }\`).join(',\\n')}
  ],
  options: {
\${Object.entries(options).map(([k, v]) => \`    \${k}: \${typeof v === 'string' ? JSON.stringify(v) : v}\`).join(',\\n')}
  },
  stream: false
};

fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(payload)
})
  .then(response => response.json())
  .then(data => console.log(data.message.content))
  .catch(error => console.error('Error:', error));
`;
  }
  
  if (format === 'go') {
    return `package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

func main() {
	url := "\${serverUrl}/api/chat"

	payload := map[string]interface{}{
		"model": "\${cfg.model}",
		"messages": []map[string]string{
\${messages.map(m => \`			{"role": "\${m.role}", "content": \${JSON.stringify(m.content)}},\`).join('\\n')}
		},
		"options": map[string]interface{}{
\${Object.entries(options).map(([k, v]) => \`			"\${k}": \${typeof v === 'string' ? JSON.stringify(v) : v},\`).join('\\n')}
		},
		"stream": false,
	}

	jsonPayload, err := json.Marshal(payload)
	if err != nil {
		fmt.Println("Error marshaling payload:", err)
		return
	}

	resp, err := http.Post(url, "application/json", bytes.NewBuffer(jsonPayload))
	if err != nil {
		fmt.Println("Error sending request:", err)
		return
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		fmt.Println("Error reading response:", err)
		return
	}

	fmt.Println(string(body))
}
`;
  }

  return '';
}

// ==========================================
// TIER 2 FEATURES (v0.0.9)
// ==========================================

// --- 1. PROMPT ENGINEERING TEMPLATES ---
const PROMPT_TEMPLATES = {
  chain_of_thought: `[System Instruction]
You are a highly analytical assistant. Break down your reasoning step-by-step.

[User Prompt]
Problem: <Describe your problem here>
Let's think step by step:
1.`,
  few_shot: `[System Instruction]
You are a precise classifier. Follow the pattern shown in the examples.

[User Prompt]
Input: The product quality is amazing!
Sentiment: Positive
---
Input: It took three weeks to arrive and was broken.
Sentiment: Negative
---
Input: It works as expected, nothing special.
Sentiment: Neutral
---
Input: <Insert your input here>
Sentiment:`,
  react: `[System Instruction]
Solve the problem using the ReAct (Reason + Action) framework. Loop through Thought, Action, and Observation.

[User Prompt]
Question: <Describe your question here>
Thought 1:`,
  code_gen: `[System Instruction]
You are an expert software engineer. Write clean, well-commented, and robust code.

[User Prompt]
Task: Write a function in <Programming Language> to <Describe task here>.
Requirements:
- Input: <Specify inputs>
- Output: <Specify outputs>
- Constraints: <Specify constraints>

Code:`,
  refine: `[System Instruction]
You are a professional editor. Improve the clarity, flow, and correctness of the provided text.

[User Prompt]
Original Text:
"""
<Insert original text here>
"""

Instructions:
1. Correct grammar and syntax errors.
2. Improve word choice for a more professional tone.
3. Output the polished text followed by a brief summary of changes.`
};

function applyPromptTemplate() {
  const select = document.getElementById('chat-template-select');
  if (!select) return;
  const val = select.value;
  if (!val) return;

  const templateText = PROMPT_TEMPLATES[val];
  if (!templateText) return;

  const textarea = document.getElementById('chat-input-text');
  if (!textarea) return;

  const currentVal = textarea.value.trim();
  if (currentVal.length > 0) {
    if (confirm("Would you like to overwrite the current input? (Click Cancel to append instead)")) {
      textarea.value = templateText;
    } else {
      textarea.value = currentVal + "\n\n" + templateText;
    }
  } else {
    textarea.value = templateText;
  }

  select.value = "";
  textarea.focus();
}

// --- 2. EXPORT & SHARE SYSTEM ---
function openExportModal() {
  const modal = document.getElementById('chat-export-modal');
  if (modal) modal.showModal();
}

function closeExportModal() {
  const modal = document.getElementById('chat-export-modal');
  if (modal) modal.close();
}

function exportChat(format) {
  if (chatMessages.length === 0) {
    showToast('Cannot export empty chat session', 'warning');
    return;
  }

  const model = document.getElementById('chat-model-select').value || 'unknown-model';
  const sysPrompt = document.getElementById('chat-system-prompt').value;
  const temp = document.getElementById('chat-temp').value;
  const ctx = document.getElementById('chat-ctx-limit').value;
  const topK = document.getElementById('chat-top-k').value;
  const topP = document.getElementById('chat-top-p').value;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `chat_export_${model.replace(/[^a-zA-Z0-9]/g, '_')}_${timestamp}`;

  if (format === 'markdown') {
    let md = `# Chat Session Export\\n`;
    md += `- **Date**: \${new Date().toLocaleString()}\\n`;
    md += `- **Model**: \\\`\${model}\\\`\\n`;
    md += `- **Parameters**: Temperature: \\\`\${temp}\\\` | Context Limit: \\\`\${ctx}\\\` | Top P: \\\`\${topP}\\\` | Top K: \\\`\${topK}\\\`\\n\\n`;
    
    if (sysPrompt) {
      md += `### System Prompt\\n\\\`\\\`\\\`\\n\${sysPrompt}\\n\\\`\\\`\\\`\\n\\n`;
    }
    md += `---\\n\\n`;

    chatMessages.forEach(msg => {
      const roleUpper = msg.role.toUpperCase();
      md += `## \${roleUpper}\\n\\n\${msg.content}\\n\\n`;
    });

    downloadFile(md, `\${filename}.md`, 'text/markdown');
    showToast('Chat exported as Markdown', 'success');
  } 
  else if (format === 'json') {
    const data = {
      exported_at: new Date().toISOString(),
      model: model,
      system_prompt: sysPrompt,
      parameters: {
        temperature: parseFloat(temp),
        num_ctx: parseInt(ctx),
        top_k: parseInt(topK),
        top_p: parseFloat(topP),
        repeat_penalty: parseFloat(document.getElementById('chat-repeat-penalty').value),
        seed: document.getElementById('chat-seed').value ? parseInt(document.getElementById('chat-seed').value) : null,
        min_p: parseFloat(document.getElementById('chat-min-p').value),
        presence_penalty: parseFloat(document.getElementById('chat-presence-penalty').value),
        frequency_penalty: parseFloat(document.getElementById('chat-frequency-penalty').value),
        num_predict: parseInt(document.getElementById('chat-num-predict').value) || -1,
        num_gpu: parseInt(document.getElementById('chat-num-gpu').value) || -1,
        num_thread: parseInt(document.getElementById('chat-num-thread').value) || -1
      },
      messages: chatMessages
    };

    downloadFile(JSON.stringify(data, null, 2), `\${filename}.json`, 'application/json');
    showToast('Chat exported as JSON', 'success');
  } 
  else if (format === 'html' || format === 'pdf') {
    const htmlContent = generateHtmlExportString(model, sysPrompt, temp, ctx, topK, topP, chatMessages);
    
    if (format === 'html') {
      downloadFile(htmlContent, `\${filename}.html`, 'text/html');
      showToast('Chat exported as HTML', 'success');
    } else {
      const printWindow = window.open('', '_blank');
      if (printWindow) {
        printWindow.document.write(htmlContent);
        printWindow.document.close();
        
        const printScript = printWindow.document.createElement('script');
        printScript.innerHTML = `
          window.addEventListener('load', () => {
            setTimeout(() => {
              window.print();
            }, 500);
          });
        `;
        printWindow.document.body.appendChild(printScript);
        showToast('Print dialog requested', 'success');
      } else {
        showToast('Pop-up blocked! Please allow pop-ups to print/export PDF.', 'error');
      }
    }
  }

  closeExportModal();
}

function downloadFile(content, filename, contentType) {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function generateHtmlExportString(model, sysPrompt, temp, ctx, topK, topP, messages) {
  let messageHtml = '';
  
  if (sysPrompt) {
    messageHtml += `
      <div class="message system">
        <div class="message-header">SYSTEM PROMPT</div>
        <div class="message-body">\${escapeHTML(sysPrompt)}</div>
      </div>
    `;
  }

  messages.forEach(msg => {
    const roleClass = msg.role;
    const roleLabel = msg.role.toUpperCase();
    let body = escapeHTML(msg.content);
    body = body.replace(/\`\`\`([\s\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>');
    
    messageHtml += `
      <div class="message \${roleClass}">
        <div class="message-header">\${roleLabel}</div>
      <div class="message ${roleClass}">
        <div class="message-header">${roleLabel}</div>
        <div class="message-body">${body}</div>
      </div>
    `;
  });

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Chat Log - ${model}</title>
  <style>
    :root {
      --nord-bg-dark: #1a1c23;
      --nord-bg: #2e3440;
      --nord-bg-panel: #242933;
      --nord-bg-hover: #3b4252;
      --nord-fg: #d8dee9;
      --nord-blue: #88c0d0;
      --nord-green: #a3be8c;
      --nord-yellow: #ebcb8b;
      --nord-border: #4c566a;
    }
    
    body {
      background-color: var(--nord-bg-dark);
      color: var(--nord-fg);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.5;
      padding: 40px 20px;
    }
    
    .container {
      max-width: 800px;
      margin: 0 auto;
    }
    
    header {
      background-color: var(--nord-bg);
      border: 1px solid var(--nord-border);
      border-radius: 8px;
      padding: 24px;
      margin-bottom: 30px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    }
    
    h1 {
      margin-top: 0;
      margin-bottom: 12px;
      font-size: 24px;
      color: var(--nord-blue);
    }
    
    .metadata {
      display: flex;
      flex-wrap: wrap;
      gap: 15px;
      font-size: 12px;
      color: #a3be8c;
    }
    
    .meta-item strong {
      color: var(--nord-fg);
    }
    
    .messages-list {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    
    .message {
      background-color: var(--nord-bg);
      border: 1px solid var(--nord-border);
      border-radius: 8px;
      padding: 20px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.05);
    }
    
    .message-header {
      font-size: 11px;
      font-weight: bold;
    }
    
    .message-body {
      font-size: 14px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    
    pre {
      background-color: var(--nord-bg-panel);
      border: 1px solid var(--nord-border);
      border-radius: 6px;
      padding: 12px;
      overflow-x: auto;
      font-family: SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
      font-size: 13px;
    }
    
    code {
      font-family: SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
      background-color: rgba(255,255,255,0.05);
      padding: 2px 4px;
      border-radius: 4px;
      font-size: 90%;
    }
    
    pre code {
      background-color: transparent;
      padding: 0;
      font-size: inherit;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Chat Session Export</h1>
      <div class="metadata">
        <div class="meta-item"><strong>Model:</strong> ${escapeHTML(model)}</div>
        <div class="meta-item"><strong>Date:</strong> ${new Date().toLocaleString()}</div>
        <div class="meta-item"><strong>Temp:</strong> ${temp}</div>
        <div class="meta-item"><strong>Ctx Limit:</strong> ${ctx} tokens</div>
        <div class="meta-item"><strong>Top P:</strong> ${topP}</div>
        <div class="meta-item"><strong>Top K:</strong> ${topK}</div>
      </div>
    </header>
    
    <div class="messages-list">
      ${messageHtml}
    </div>
  </div>
</body>
</html>`;
}

// --- 3. MODEL CARD FETCHING & PARSING ---
function getModelCardSourceUrl(modelName) {
  if (!modelName) return '#';
  if (modelName.includes('hf.co/') || modelName.includes('/')) {
    let cleaned = modelName.startsWith('hf.co/') ? modelName.slice(6) : modelName;
    cleaned = cleaned.split(':')[0];
    return `https://huggingface.co/${cleaned}`;
  }
  return `https://ollama.com/library/${modelName.split(':')[0]}`;
}

function renderModelCard(container) {
  if (!modelCardCache) return;

  const sourceUrl = getModelCardSourceUrl(modelCardCache.modelName);
  const activeSafe = modelCardViewMode === 'safe';
  const activeRaw = modelCardViewMode === 'raw';
  const btnBase = 'btn btn-xs border-[#4c566a] font-tech text-[9px] px-2 h-6 min-h-0';
  const toolbar = `
    <div class="not-prose mb-3 p-2 bg-[#242933] border border-[#4c566a]/50 rounded-lg flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono whitespace-normal">
      <span class="text-[#88c0d0] font-bold flex items-center gap-1.5">
        <i class="fa-solid fa-shield-halved"></i> External model card
      </span>
      <div class="flex items-center gap-1.5">
        <button onclick="setModelCardViewMode('safe')" class="${btnBase} ${activeSafe ? 'btn-info' : 'btn-neutral'}">SAFE</button>
        <button onclick="setModelCardViewMode('raw')" class="${btnBase} ${activeRaw ? 'btn-info' : 'btn-neutral'}">RAW</button>
        <a href="${escapeHTML(sourceUrl)}" target="_blank" rel="noopener noreferrer" class="${btnBase} btn-outline btn-info inline-flex items-center gap-1">
          <i class="fa-solid fa-arrow-up-right-from-square"></i> SOURCE
        </a>
      </div>
    </div>
  `;

  if (activeRaw) {
    container.className = "whitespace-pre-wrap break-all pr-8 leading-relaxed font-tech text-[11px] font-mono text-[#d8dee9]";
    container.innerHTML = toolbar + `<code class="whitespace-pre-wrap break-all">${escapeHTML(modelCardCache.rawBody)}</code>`;
    return;
  }

  container.classList.remove('font-mono');
  container.classList.add('prose', 'prose-invert', 'max-w-none', 'p-2');
  container.innerHTML = toolbar + modelCardCache.safeHTML;
}

function setModelCardViewMode(mode) {
  modelCardViewMode = mode === 'raw' ? 'raw' : 'safe';
  const container = document.getElementById('tab-content-text');
  if (activeDetailTab === 'card' && container) {
    renderModelCard(container);
  }
}

async function fetchModelCard(modelName, container) {
  try {
    const resp = await fetch(`/api/models/card?name=${encodeURIComponent(modelName)}`);
    if (!resp.ok) {
      throw new Error(`Failed to fetch card: status ${resp.status}`);
    }
    const body = await resp.text();

    const isHF = modelName.includes('hf.co/') || modelName.includes('/');
    let safeHTML = '';
    if (isHF) {
      if (window.marked) {
        safeHTML = sanitizeExternalHTML(marked.parse(body));
      } else {
        safeHTML = `<pre class="whitespace-pre-wrap break-all">${escapeHTML(body)}</pre>`;
      }
    } else {
      const parser = new DOMParser();
      const doc = parser.parseFromString(body, 'text/html');
      const displayDiv = doc.getElementById('display') || doc.getElementById('readme') || doc.querySelector('.prose');
      if (displayDiv) {
        displayDiv.querySelectorAll('a').forEach(a => {
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
          a.classList.add('text-[#88c0d0]', 'hover:underline');
        });
        safeHTML = sanitizeExternalHTML(displayDiv.innerHTML);
      } else {
        safeHTML = sanitizeExternalHTML(doc.body.innerHTML);
      }
    }
    modelCardCache = { modelName, rawBody: body, safeHTML };
    renderModelCard(container);
  } catch (err) {
    container.textContent = `Error loading model card: ${err.message}\n\nYou can view the library page online at:\n- Ollama: https://ollama.com/library/${modelName.split(':')[0]}\n- HuggingFace: https://huggingface.co/${modelName}`;
  }
}

// --- 4. SINGLE-COMPLETION WORKSPACE ---
let isGeneratingCompletion = false;
let completionAbortController = null;

const completionConfigIds = [
  'completion-model-select',
  'completion-system-prompt',
  'completion-temp',
  'completion-ctx-limit',
  'completion-top-k',
  'completion-top-p',
  'completion-repeat-penalty',
  'completion-num-predict',
  'completion-num-gpu',
  'completion-num-thread',
  'completion-prompt-text',
  'completion-document-text'
];

function saveCompletionSettings() {
  completionConfigIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      setPref(id, el.value);
    }
  });
}

function loadCompletionSettings() {
  completionConfigIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      const saved = getPref(id, null);
      if (saved !== null) {
        el.value = saved;
        const valueEl = document.getElementById(id + '-value');
        if (valueEl) {
          valueEl.textContent = saved;
        }
      }
    }
  });
}

function clearCompletionPrompt() {
  const textarea = document.getElementById('completion-prompt-text');
  if (textarea) {
    textarea.value = '';
    saveCompletionSettings();
  }
}

function clearCompletionDocument() {
  const textarea = document.getElementById('completion-document-text');
  if (textarea) {
    textarea.value = '';
    document.getElementById('completion-token-count').textContent = '0';
    saveCompletionSettings();
  }
}

function copyCompletionDocument() {
  const textarea = document.getElementById('completion-document-text');
  if (!textarea || !textarea.value) return;

  navigator.clipboard.writeText(textarea.value).then(() => {
    showToast('Document content copied to clipboard', 'success');
  }).catch(err => {
    showToast('Failed to copy document content', 'error');
  });
}

function abortCompletion() {
  if (completionAbortController) {
    completionAbortController.abort();
    showToast('Completion generation aborted', 'warning');
  }
}

async function generateCompletion() {
  if (isGeneratingCompletion) return;

  const model = document.getElementById('completion-model-select').value;
  if (!model) {
    showToast('Please select a model for completion', 'warning');
    return;
  }

  const prompt = document.getElementById('completion-prompt-text').value.trim();
  if (!prompt) {
    showToast('Please enter a completion prompt', 'warning');
    return;
  }
  addToPromptHistory(prompt);

  const sysPrompt = document.getElementById('completion-system-prompt').value;
  const temp = parseFloat(document.getElementById('completion-temp').value);
  const ctx = parseInt(document.getElementById('completion-ctx-limit').value);
  const topK = parseInt(document.getElementById('completion-top-k').value);
  const topP = parseFloat(document.getElementById('completion-top-p').value);
  const repeatPenalty = parseFloat(document.getElementById('completion-repeat-penalty').value);

  const numPredictInputVal = document.getElementById('completion-num-predict').value;
  const numPredict = (numPredictInputVal === '' || isNaN(parseInt(numPredictInputVal))) ? null : parseInt(numPredictInputVal);
  const numGpuInputVal = document.getElementById('completion-num-gpu').value;
  const numGpu = (numGpuInputVal === '' || isNaN(parseInt(numGpuInputVal))) ? null : parseInt(numGpuInputVal);
  const numThreadInputVal = document.getElementById('completion-num-thread').value;
  const numThread = (numThreadInputVal === '' || isNaN(parseInt(numThreadInputVal))) ? null : parseInt(numThreadInputVal);

  isGeneratingCompletion = true;
  document.getElementById('completion-generate-btn').disabled = true;
  document.getElementById('completion-stop-btn').disabled = false;
  
  const statusText = document.getElementById('completion-status-text');
  statusText.textContent = "GENERATING COMPLETION...";
  statusText.parentElement.firstElementChild.classList.remove('bg-[#a3be8c]');
  statusText.parentElement.firstElementChild.classList.add('bg-[#ebcb8b]');

  const tokenCountEl = document.getElementById('completion-token-count');
  let tokenCount = 0;
  tokenCountEl.textContent = tokenCount.toString();

  const docTextarea = document.getElementById('completion-document-text');
  
  if (docTextarea.value.trim() !== '') {
    docTextarea.value += '\\n\\n';
  }

  completionAbortController = new AbortController();

  const requestBody = {
    model: model,
    prompt: prompt,
    system_prompt: sysPrompt,
    temperature: temp,
    num_ctx: ctx,
    top_k: topK,
    top_p: topP,
    repeat_penalty: repeatPenalty,
  };

  if (numPredict !== null) requestBody.num_predict = numPredict;
  if (numGpu !== null) requestBody.num_gpu = numGpu;
  if (numThread !== null) requestBody.num_thread = numThread;

  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal: completionAbortController.signal
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Server returned ${response.status}: ${errText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.trim() === '') continue;

        if (line.startsWith('data: ')) {
          const rawJson = line.slice(6).trim();
          if (rawJson === 'stream finished' || rawJson === 'done') continue;
          
          try {
            const data = JSON.parse(rawJson);
            if (data.response) {
              docTextarea.value += data.response;
              docTextarea.scrollTop = docTextarea.scrollHeight;
              
              tokenCount++;
              tokenCountEl.textContent = tokenCount.toString();
            }
          } catch (e) {
            console.error('Error parsing SSE JSON:', e, rawJson);
          }
        }
      }
    }

    statusText.textContent = "COMPLETION FINISHED";
    showToast('Completion generation complete', 'success');

  } catch (err) {
    if (err.name === 'AbortError') {
      statusText.textContent = "COMPLETION ABORTED";
    } else {
      statusText.textContent = "ERROR: " + err.message;
      showToast(`Generation error: ${err.message}`, 'error');
      recordStreamFailure('completion', err.message, { model, node: activeServerLabel() });
    }
  } finally {
    isGeneratingCompletion = false;
    document.getElementById('completion-generate-btn').disabled = false;
    document.getElementById('completion-stop-btn').disabled = true;

    statusText.parentElement.firstElementChild.classList.remove('bg-[#ebcb8b]');
    statusText.parentElement.firstElementChild.classList.add('bg-[#a3be8c]');
    
    completionAbortController = null;
    saveCompletionSettings();
  }
}

// --- MULTIMODAL / IMAGE HANDLERS ---

function triggerChatImageUpload() {
  const input = document.getElementById('chat-image-input');
  if (input) {
    input.value = '';
    input.click();
  }
}

function handleChatImageFiles(files) {
  if (!files || files.length === 0) return;
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file.type.startsWith('image/')) {
      showToast('Only image files are supported', 'warning');
      continue;
    }
    
    const reader = new FileReader();
    reader.onload = function(e) {
      const fullBase64 = e.target.result;
      const commaIdx = fullBase64.indexOf(',');
      let pureBase64 = fullBase64;
      if (commaIdx !== -1) {
        pureBase64 = fullBase64.substring(commaIdx + 1);
      }
      
      selectedImages.push(pureBase64);
      renderImagePreviews();
    };
    reader.readAsDataURL(file);
  }
}

function removeSelectedImage(index) {
  selectedImages.splice(index, 1);
  renderImagePreviews();
}

function renderImagePreviews() {
  const previewBar = document.getElementById('chat-image-preview-bar');
  if (!previewBar) return;
  
  if (selectedImages.length === 0) {
    previewBar.innerHTML = '';
    return;
  }
  
  let html = '';
  selectedImages.forEach((img, idx) => {
    const src = img.startsWith('data:') ? img : `data:image/jpeg;base64,${img}`;
    html += `
      <div class="relative w-16 h-16 group border border-[#4c566a] rounded overflow-hidden">
        <img src="${src}" class="w-full h-full object-cover" />
        <button onclick="removeSelectedImage(${idx})" class="absolute top-0 right-0 bg-[#bf616a] text-white rounded-bl w-5 h-5 flex items-center justify-center text-xs opacity-80 hover:opacity-100 transition-opacity" title="Remove">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    `;
  });
  previewBar.innerHTML = html;
}

function viewFullImage(src) {
  const modal = document.getElementById('image-lightbox-modal');
  const img = document.getElementById('lightbox-image-el');
  if (modal && img) {
    img.src = src;
    modal.showModal();
  }
}

function closeImageLightbox() {
  const modal = document.getElementById('image-lightbox-modal');
  if (modal) {
    modal.close();
  }
}

// ============================================================================
// TELEMETRY SSE, MODEL UPDATE SCHEDULER & BENCHMARK INFERENCE RUNNER (v0.0.4)
// ============================================================================

// ── Fleet Overview (Phase 4 — item 15) ───────────────────────────────────────

async function fetchFleetOverview() {
  const grid    = document.getElementById('fleet-grid');
  const summary = document.getElementById('fleet-status-summary');
  if (grid) grid.innerHTML = '<div class="text-center py-8 text-[#4c566a] italic text-xs col-span-full"><i class="fa-solid fa-circle-notch animate-spin mr-2"></i>Querying fleet…</div>';

  try {
    const resp = await fetch('/api/nodes/overview');
    if (!resp.ok) throw new Error('Failed to fetch fleet overview');
    const nodes = await resp.json();
    renderFleetGrid(nodes);
  } catch (e) {
    if (grid) grid.innerHTML = `<div class="text-center py-8 text-[#bf616a]/80 text-xs col-span-full"><i class="fa-solid fa-circle-exclamation mr-1.5"></i>${e.message}</div>`;
  }
}

function renderFleetGrid(nodes) {
  const grid    = document.getElementById('fleet-grid');
  const summary = document.getElementById('fleet-status-summary');
  if (!grid) return;

  if (nodes.length === 0) {
    grid.innerHTML = '<div class="text-center py-8 text-[#4c566a] italic text-xs col-span-full">No nodes configured.</div>';
    return;
  }

  const online  = nodes.filter(n => n.status === 'online').length;
  const offline = nodes.length - online;
  if (summary) {
    summary.textContent = `${online} online / ${offline} offline`;
    summary.className   = offline > 0
      ? 'text-[9px] font-mono text-[#bf616a]'
      : 'text-[9px] font-mono text-[#a3be8c]';
  }

  grid.innerHTML = nodes.map(node => {
    const isOnline  = node.status === 'online';
    const dotColor  = isOnline ? 'bg-[#a3be8c] status-glow-online' : 'bg-[#bf616a] status-glow-offline';
    const border    = isOnline ? 'border-[#4c566a]/50 hover:border-[#88c0d0]/40' : 'border-[#4c566a]/30 opacity-70';
    const seenAgo   = serverLastSeen[node.id] ? timeAgoShort(serverLastSeen[node.id]) : (node.cache_updated_at ? timeAgoShort(node.cache_updated_at * 1000) : '—');
    const isActive  = servers.find(s => s.id === node.id)?.isActive;

    return `
      <div class="tech-panel rounded-xl p-3 border ${border} flex flex-col gap-2 transition-all group relative">
        <!-- Status + name row -->
        <div class="flex items-start justify-between gap-2">
          <div class="flex items-center gap-2 min-w-0">
            <span class="h-2 w-2 rounded-full shrink-0 ${dotColor}"></span>
            <div class="min-w-0">
              <p class="font-bold text-xs text-[#e5e9f0] truncate" title="${node.name}">${node.name}</p>
              <p class="text-[9px] font-mono text-[#4c566a] truncate" title="${node.url}">${node.url}</p>
            </div>
          </div>
          ${isActive ? '<span class="shrink-0 text-[8px] font-mono font-bold text-[#88c0d0] border border-[#88c0d0]/40 rounded px-1 py-0.5">ACTIVE</span>' : ''}
        </div>

        <!-- Stats row -->
        <div class="grid grid-cols-2 gap-x-3 gap-y-1 text-[9px] font-mono">
          <div class="text-[#4c566a]">Status</div>
          <div class="${isOnline ? 'text-[#a3be8c]' : 'text-[#bf616a]'} font-semibold uppercase">${node.status}</div>

          <div class="text-[#4c566a]">Latency</div>
          <div class="text-[#d8dee9]">${isOnline ? node.latency_ms + ' ms' : '—'}</div>

          <div class="text-[#4c566a]">Version</div>
          <div class="text-[#d8dee9] truncate">${node.version || '—'}</div>

          <div class="text-[#4c566a]">Models</div>
          <div class="text-[#d8dee9]">${node.model_count}</div>

          <div class="text-[#4c566a]">Updated</div>
          <div class="text-[#4c566a]">${seenAgo}</div>
        </div>

        <!-- Action row -->
        <div class="flex items-center gap-1 pt-1 border-t border-[#4c566a]/20">
          ${!isActive ? `
            <button onclick="selectServer('${node.id}')" class="btn btn-xs btn-outline btn-info flex-1 font-tech text-[9px] h-6 min-h-0">
              SET ACTIVE
            </button>` : `
            <span class="flex-1 text-[9px] font-mono text-[#88c0d0] text-center">Active node</span>`}
          <button onclick="refreshNode('${node.id}')" class="btn btn-xs btn-ghost text-[#4c566a] hover:text-[#88c0d0] p-1 h-6 min-h-0" title="Refresh">
            <i class="fa-solid fa-rotate text-[9px]"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

// ── Cross-node model search (Phase 4 — item 16) ───────────────────────────────

function handleCrossNodeSearch(value) {
  crossNodeSearchQuery = value.trim();
  const clearBtn = document.getElementById('cross-node-search-clear');
  if (clearBtn) clearBtn.classList.toggle('hidden', !crossNodeSearchQuery);

  // Debounce 300ms
  clearTimeout(crossNodeSearchTimer);
  if (!crossNodeSearchQuery) {
    clearCrossNodeSearch(false); // restore normal inventory without clearing the input
    return;
  }
  crossNodeSearchTimer = setTimeout(() => runCrossNodeSearch(crossNodeSearchQuery), 300);
}

async function runCrossNodeSearch(q) {
  const statusEl = document.getElementById('cross-node-search-status');
  if (statusEl) { statusEl.textContent = 'Searching all nodes…'; statusEl.classList.remove('hidden'); }

  try {
    const resp = await fetch(`/api/models/search?q=${encodeURIComponent(q)}&nodes=all`);
    if (!resp.ok) throw new Error('Search failed');
    const data = await resp.json();
    renderCrossNodeResults(data.results || [], q);
    if (statusEl) {
      statusEl.textContent = `${data.total} result${data.total === 1 ? '' : 's'} across all nodes`;
    }
  } catch (e) {
    if (statusEl) { statusEl.textContent = 'Search failed'; statusEl.classList.remove('hidden'); }
  }
}

function renderCrossNodeResults(results, q) {
  const listBody = document.getElementById('models-list-body');
  const paginationEl = document.getElementById('inventory-pagination');
  const totalBadge   = document.getElementById('inventory-total-badge');

  // Hide normal pagination in search mode
  if (paginationEl) { paginationEl.classList.add('hidden'); paginationEl.classList.remove('flex'); }
  if (totalBadge) { totalBadge.textContent = `(${results.length} across all nodes)`; totalBadge.classList.remove('hidden'); }

  // Detach accordion
  if (accordionEl && accordionEl.parentNode === listBody) listBody.removeChild(accordionEl);

  if (results.length === 0) {
    listBody.innerHTML = `<tr><td colspan="5" class="text-center py-8 text-[#4c566a] italic text-xs">No models matching "${q}" found on any node.</td></tr>`;
    return;
  }

  listBody.innerHTML = results.map(r => {
    const sizeFormatted = formatBytes(r.size);
    const paramSize     = (r.details && r.details.parameter_size) || 'N/A';
    const isActiveNode  = servers.find(s => s.id === r.node_id)?.isActive;
    const nodeBadgeColor = isActiveNode ? 'border-[#88c0d0] text-[#88c0d0]' : 'border-[#4c566a] text-[#4c566a]';

    return `
      <tr class="hover:bg-[#3b4252]/30 border-b border-[#4c566a]/30 transition-colors">
        <td>
          <span class="badge badge-outline text-[8px] font-mono font-bold ${nodeBadgeColor} whitespace-nowrap"
                title="${r.url}">${r.node_name || r.node_id}</span>
        </td>
        <td>
          <span class="font-bold text-[#e5e9f0] text-xs">${r.name}</span>
          <span class="text-[9px] text-[#4c566a] block">${sizeFormatted} // ${paramSize}</span>
        </td>
        <td class="hidden sm:table-cell text-xs">${sizeFormatted}</td>
        <td class="hidden md:table-cell">
          <span class="badge badge-outline border-[#4c566a] text-[#81a1c1] text-[9px] font-mono">${paramSize}</span>
        </td>
        <td>
          ${isActiveNode
            ? `<button onclick="inspectModel('${r.name}')" class="btn btn-xs btn-neutral border-[#4c566a] text-[10px] font-tech">INSPECT</button>`
            : `<button onclick="selectServer('${r.node_id}')" class="btn btn-xs btn-outline btn-info text-[9px] font-tech">SET ACTIVE</button>`}
        </td>
      </tr>
    `;
  }).join('');

  // Hide select-all checkbox in search mode
  const cb = document.getElementById('select-all-checkbox');
  if (cb) cb.parentElement.classList.add('hidden');
}

function clearCrossNodeSearch(resetInput = true) {
  crossNodeSearchQuery = '';
  clearTimeout(crossNodeSearchTimer);
  if (resetInput) {
    const input = document.getElementById('cross-node-search');
    if (input) input.value = '';
  }
  const clearBtn = document.getElementById('cross-node-search-clear');
  if (clearBtn) clearBtn.classList.add('hidden');
  const statusEl = document.getElementById('cross-node-search-status');
  if (statusEl) statusEl.classList.add('hidden');

  // Restore select-all checkbox
  const cb = document.getElementById('select-all-checkbox');
  if (cb) cb.parentElement.classList.remove('hidden');

  // Re-render normal inventory
  renderModels();
}

// ── Telemetry SSE ─────────────────────────────────────────────────────────────

let telemetryEventSource = null;
let telemetryHistory = [];
let loadedModels = [];           // module-level mirror of active_models for footer actions
const MAX_TELEMETRY_POINTS = 50;

// handleNodeStatusUpdate: called when the backend pushes a nodeStatus SSE event.
// Updates the server card status dot, latency, and version in-place without
// re-fetching the full server list.
function handleNodeStatusUpdate(updated) {
  const idx = servers.findIndex(s => s.id === updated.id);
  if (idx === -1) return; // unknown node — ignore

  const prev = servers[idx];
  servers[idx] = {
    ...prev,
    status:  updated.status,
    latency: updated.latency,
    version: updated.version,
  };
  serverLastSeen[updated.id] = Date.now();

  // Re-render the server list to reflect the new status dot / latency / timestamp.
  renderServers();

  // If the fleet tab is open, refresh the grid to show updated status.
  if (activeWorkspace === 'fleet') fetchFleetOverview();

  // If this is the active server, also refresh the footer status indicator.
  if (servers[idx].isActive) {
    updateActiveServerUI(servers[idx]);
  }
}

function startTelemetrySSE() {
  if (telemetryEventSource) {
    telemetryEventSource.close();
  }

  telemetryEventSource = new EventSource('/api/telemetry/stream');

  telemetryEventSource.addEventListener('telemetry', (e) => {
    try {
      const data = JSON.parse(e.data);
      handleTelemetryData(data);
    } catch (err) {
      console.error('Failed to parse telemetry data', err);
    }
  });

  // Reactive node-status updates pushed by the backend poller on state changes.
  telemetryEventSource.addEventListener('nodeStatus', (e) => {
    try {
      const updated = JSON.parse(e.data);
      handleNodeStatusUpdate(updated);
    } catch (err) {
      console.error('Failed to parse nodeStatus event', err);
    }
  });

  telemetryEventSource.onerror = (err) => {
    console.warn('Telemetry connection lost. Retrying...');
    const nodeBadge = document.getElementById('node-badge');
    if (nodeBadge) {
      nodeBadge.textContent = 'DISCONNECTED';
      nodeBadge.className = 'badge badge-xs py-2 px-2 font-mono font-bold bg-[#bf616a] text-[#d8dee9] border-none';
    }
  };
}

function handleTelemetryData(data) {
  // Update connectivity badge
  const nodeBadge = document.getElementById('node-badge');
  if (nodeBadge) {
    const isRemote = data.ollama_node.is_remote;
    let host = data.ollama_node.url;
    try {
      const urlObj = new URL(data.ollama_node.url);
      host = urlObj.host;
    } catch (e) {}
    nodeBadge.textContent = isRemote ? 'REMOTE' : 'LOCAL';
    nodeBadge.className = isRemote
      ? 'badge badge-xs py-2 px-2 font-mono font-bold bg-[#81a1c1] text-[#2e3440] border-none shadow-sm shadow-[#81a1c1]/20'
      : 'badge badge-xs py-2 px-2 font-mono font-bold bg-[#a3be8c] text-[#2e3440] border-none shadow-sm shadow-[#a3be8c]/20';
  }

  // Update URL & Type
  const nodeUrlEl = document.getElementById('telemetry-node-url');
  if (nodeUrlEl) {
    nodeUrlEl.textContent = data.ollama_node.url || '---';
  }
  const nodeTypeEl = document.getElementById('telemetry-node-type');
  if (nodeTypeEl) {
    nodeTypeEl.textContent = data.ollama_node.is_remote ? 'REMOTE' : 'LOCAL';
  }

  // Update CPU/RAM bars — labels stay as "HOST CPU / HOST RAM" set in HTML
  const cpuText = document.getElementById('host-cpu-text');
  const cpuBar = document.getElementById('host-cpu-bar');
  if (cpuText && cpuBar) {
    cpuText.textContent = `${data.app_host.cpu.toFixed(1)}%`;
    cpuBar.style.width = `${Math.min(100, data.app_host.cpu)}%`;
  }

  const ramText = document.getElementById('host-ram-text');
  const ramBar = document.getElementById('host-ram-bar');
  if (ramText && ramBar) {
    const usedGb = data.app_host.ram_used / (1024 * 1024 * 1024);
    const totalGb = data.app_host.ram_total / (1024 * 1024 * 1024);
    ramText.textContent = `${usedGb.toFixed(1)} GB / ${totalGb.toFixed(1)} GB`;
    const percent = data.app_host.ram_total > 0 ? (data.app_host.ram_used / data.app_host.ram_total) * 100 : 0;
    ramBar.style.width = `${Math.min(100, percent)}%`;
  }

  // Compute Ollama node stats from /api/ps active_models
  const activeModels = data.active_models || [];
  loadedModels = activeModels;   // keep module-level mirror in sync
  let totalVramBytes = 0, totalSysRamBytes = 0;
  activeModels.forEach(m => {
    totalVramBytes  += m.size_vram || 0;
    totalSysRamBytes += Math.max(0, (m.size || 0) - (m.size_vram || 0));
  });

  const ollamaVramText = document.getElementById('ollama-vram-text');
  const ollamaVramBar  = document.getElementById('ollama-vram-bar');
  const ollamaSysText  = document.getElementById('ollama-sysram-text');
  const ollamaSysBar   = document.getElementById('ollama-sysram-bar');

  // Look up manually configured VRAM for the active server
  const activeSrv = servers.find(s => s.isActive);
  const configuredVramBytes = (activeSrv?.vramGb || 0) * (1024 ** 3);
  const usedVramGb = totalVramBytes / (1024 ** 3);

  // Detect whether active server is local (app host == Ollama host)
  const isLocalNode = !activeSrv?.url || /localhost|127\.0\.0\.1/.test(activeSrv.url);

  if (ollamaVramText) {
    if (activeModels.length > 0) {
      const usedStr = `${usedVramGb.toFixed(2)} GB`;
      const capStr  = configuredVramBytes > 0 ? ` / ${activeSrv.vramGb} GB` : '';
      ollamaVramText.textContent = `${usedStr}${capStr}`;
    } else {
      ollamaVramText.textContent = '--- (idle)';
    }
  }
  if (ollamaSysText) {
    if (!isLocalNode) {
      ollamaSysText.textContent = 'Local Ollama only';
    } else {
      ollamaSysText.textContent = activeModels.length > 0
        ? `${(totalSysRamBytes / (1024 ** 3)).toFixed(2)} GB`
        : '--- (idle)';
    }
  }

  // Bar widths: use configured VRAM as scale if available, else fall back to host RAM total
  const ramTotal  = data.app_host.ram_total || 1;
  const vramScale = configuredVramBytes > 0 ? configuredVramBytes : ramTotal;
  if (ollamaVramBar)  ollamaVramBar.style.width  = `${Math.min(100, (totalVramBytes  / vramScale) * 100)}%`;
  if (ollamaSysBar)   ollamaSysBar.style.width    = isLocalNode ? `${Math.min(100, (totalSysRamBytes / ramTotal) * 100)}%` : '0%';

  // ── Footer model-loaded indicator ─────────────────────────────────────────
  const modelIndicator     = document.getElementById('global-model-indicator');
  const modelIndicatorName = document.getElementById('global-model-indicator-name');
  const modelIndicatorVram = document.getElementById('global-model-indicator-vram');
  const footerUnloadBtn    = document.getElementById('footer-unload-btn');
  if (modelIndicator && modelIndicatorName && modelIndicatorVram) {
    if (activeModels.length === 0) {
      modelIndicator.className = 'flex items-center gap-1.5 text-[#4c566a]';
      modelIndicatorName.textContent = 'IDLE';
      modelIndicatorVram.textContent = '';
      modelIndicatorVram.classList.add('hidden');
      if (footerUnloadBtn) footerUnloadBtn.classList.add('hidden');
    } else {
      modelIndicator.className = 'flex items-center gap-1.5 text-[#a3be8c]';
      const totalLabel = configuredVramBytes > 0 ? `/${activeSrv.vramGb}G` : '';
      const vramStr    = `· ${usedVramGb.toFixed(1)}G${totalLabel}`;
      if (activeModels.length === 1) {
        const m        = activeModels[0];
        const baseName = (m.name || '').split(':')[0].split('/').pop();
        const params   = m.details?.parameter_size || '';
        const quant    = m.details?.quantization_level || '';
        const meta     = [params, quant].filter(Boolean).join(' ');
        modelIndicatorName.textContent = meta ? `${baseName} ${meta}` : baseName;
      } else {
        modelIndicatorName.textContent = `${activeModels.length} models`;
      }
      modelIndicatorVram.textContent = vramStr;
      modelIndicatorVram.classList.remove('hidden');
      if (footerUnloadBtn) footerUnloadBtn.classList.remove('hidden');
      // Full names in title for hover tooltip
      modelIndicator.title = activeModels.map(m => m.name).join('\n');
    }
  }

  // Update active models grid and chart if Memory sub-tab is active
  if (activeWorkspace === 'system' && activeSystemSubtab === 'memory') {
    updateTelemetryChart(data);
    renderTelemetryModels(data.active_models);
  }
}

function renderTelemetryModels(activeModels) {
  const container = document.getElementById('memory-models-container');
  if (!container) return;
  
  if (!activeModels || activeModels.length === 0) {
    container.innerHTML = `
      <div class="col-span-full text-center py-16 text-[#4c566a] border border-dashed border-[#4c566a]/40 rounded-xl">
        <i class="fa-solid fa-microchip text-2xl mb-2 animate-pulse"></i>
        <p class="font-tech text-xs uppercase tracking-widest text-[#88c0d0]">Memory Idle</p>
        <p class="text-[10px] mt-1 max-w-sm mx-auto">No LLM parameters are currently mapped into RAM or GPU VRAM. Active models are automatically loaded upon first inference.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = activeModels.map(model => {
    const totalBytes = model.size;
    const vramBytes = model.size_vram;
    const offloadRatio = totalBytes > 0 ? (vramBytes / totalBytes) * 100 : 0;
    
    const vramFormatted = formatBytes(vramBytes);
    const systemBytes = totalBytes - vramBytes;
    const systemFormatted = formatBytes(systemBytes);
    
    let offloadLabel = '';
    let progressColorClass = 'bg-gradient-to-r from-[#81a1c1] to-[#88c0d0]';
    
    if (offloadRatio >= 99.9) {
      offloadLabel = '100% GPU (VRAM)';
      progressColorClass = 'bg-[#a3be8c]';
    } else if (offloadRatio <= 0.1) {
      offloadLabel = '100% CPU (SYSTEM)';
      progressColorClass = 'bg-[#bf616a]';
    } else {
      offloadLabel = `${offloadRatio.toFixed(1)}% GPU / ${(100 - offloadRatio).toFixed(1)}% CPU`;
    }

    const expiresAt = new Date(model.expires_at);
    const diffMs = expiresAt - Date.now();
    const diffMinutes = Math.max(0, Math.round(diffMs / 1000 / 60));

    return `
      <div class="p-4 border border-[#4c566a]/60 bg-[#242933]/40 rounded-xl flex flex-col justify-between gap-4 font-mono text-xs">
        <div>
          <div class="flex justify-between items-start">
            <div>
              <h3 class="font-bold text-sm text-[#e5e9f0] truncate max-w-[200px]">${escapeHTML(model.name)}</h3>
              <span class="badge badge-outline border-[#4c566a] text-[#81a1c1] text-[9px] mt-1 font-mono">${(model.details && model.details.parameter_size) || 'N/A'}</span>
            </div>
            <button onclick="unloadModel('${model.name}')" class="btn btn-xs btn-error font-tech text-[9px] gap-1">
              <i class="fa-solid fa-power-off"></i> EVICT
            </button>
          </div>

          <div class="mt-4 space-y-1">
            <div class="flex justify-between text-[10px]">
              <span class="text-[#88c0d0]">OFFLOAD RATIO:</span>
              <span class="font-semibold text-[#e5e9f0]">${offloadLabel}</span>
            </div>
            <div class="w-full h-3.5 bg-[#1e222a] rounded overflow-hidden border border-[#4c566a]/40 p-0.5">
              <div class="h-full rounded ${progressColorClass}" style="width: ${offloadRatio.toFixed(1)}%"></div>
            </div>
            <div class="flex justify-between text-[9px] text-[#4c566a]">
              <span>VRAM: ${vramFormatted}</span>
              <span>System: ${systemFormatted}</span>
            </div>
          </div>
        </div>

        <div class="border-t border-[#4c566a]/30 pt-2 flex justify-between items-center text-[9px] text-[#4c566a]">
          <span>Total Weight: ${formatBytes(totalBytes)}</span>
          <span>Unloads in: ~${diffMinutes}m</span>
        </div>
      </div>
    `;
  }).join('');
}

function updateTelemetryChart(payload) {
  const canvas = document.getElementById('telemetry-chart');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * window.devicePixelRatio;
  canvas.height = rect.height * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

  const width = rect.width;
  const height = rect.height;

  const cpuVal = payload.app_host.cpu;
  const ramVal = payload.app_host.ram_total > 0 
    ? (payload.app_host.ram_used / payload.app_host.ram_total) * 100 
    : 0;
  
  let totalVramBytes = 0;
  if (payload.active_models && payload.active_models.length > 0) {
    payload.active_models.forEach(m => {
      totalVramBytes += m.size_vram || 0;
    });
  }
  const vramGb = totalVramBytes / (1024 * 1024 * 1024);

  telemetryHistory.push({ cpu: cpuVal, ram: ramVal, vram: vramGb });
  if (telemetryHistory.length > MAX_TELEMETRY_POINTS) {
    telemetryHistory.shift();
  }

  ctx.fillStyle = '#1a1c23';
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(76, 86, 106, 0.15)';
  ctx.lineWidth = 1;
  const gridRows = 5;
  const gridCols = 10;
  for (let i = 1; i < gridRows; i++) {
    const y = (height / gridRows) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  for (let i = 1; i < gridCols; i++) {
    const x = (width / gridCols) * i;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  if (telemetryHistory.length < 2) return;

  const activeSrvForChart = (typeof servers !== 'undefined') ? servers.find(s => s.isActive) : null;
  const configuredVramGb  = activeSrvForChart?.vramGb || 0;
  let maxVramInHistory = Math.max(8, configuredVramGb);
  telemetryHistory.forEach(pt => {
    if (pt.vram > maxVramInHistory) {
      maxVramInHistory = pt.vram;
    }
  });
  maxVramInHistory = Math.ceil(maxVramInHistory / 4) * 4;

  // Reserve 52px at the top for the 3-line text legend so chart lines
  // never clip the legend text even at 100% utilisation.
  const LEGEND_RESERVE = 52;
  const CHART_BOTTOM_PAD = 6;

  function drawLine(key, color, maxVal) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;

    for (let i = 0; i < telemetryHistory.length; i++) {
      const pt = telemetryHistory[i];
      const val = pt[key];
      const x = (width / (MAX_TELEMETRY_POINTS - 1)) * i;
      const y = height - CHART_BOTTOM_PAD
              - (val / maxVal) * (height - LEGEND_RESERVE - CHART_BOTTOM_PAD);

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    ctx.lineTo((width / (MAX_TELEMETRY_POINTS - 1)) * (telemetryHistory.length - 1), height);
    ctx.lineTo(0, height);
    ctx.closePath();
    
    const fillColor = color.replace(/,\s*[\d.]+\)$/, ', 0.15)');
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, fillColor);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fill();
  }

  drawLine('cpu', 'rgba(136, 192, 208, 1)', 100);
  drawLine('ram', 'rgba(163, 190, 140, 1)', 100);
  drawLine('vram', 'rgba(235, 203, 139, 1)', maxVramInHistory);

  ctx.font = '9px monospace';
  ctx.fillStyle = '#88c0d0';
  ctx.fillText(`HOST CPU: ${cpuVal.toFixed(1)}%`, 10, 15);
  ctx.fillStyle = '#a3be8c';
  ctx.fillText(`HOST RAM: ${ramVal.toFixed(1)}%`, 10, 27);
  ctx.fillStyle = '#ebcb8b';
  const vramScaleLabel = configuredVramGb > 0 ? `${configuredVramGb} GB` : `${maxVramInHistory} GB`;
  ctx.fillText(`OLLAMA VRAM IN USE: ${vramGb.toFixed(2)} GB / ${vramScaleLabel}`, 10, 39);
}

// --- MODEL UPDATE SCHEDULER ---

async function fetchSchedulerSettings() {
  try {
    const response = await fetch('/api/settings');
    if (!response.ok) throw new Error('Failed to fetch settings');
    const settings = await response.json();
    
    const intervalSelect = document.getElementById('scheduler-interval-select');
    if (intervalSelect && settings.update_schedule) {
      intervalSelect.value = settings.update_schedule;
    }
  } catch (error) {
    console.error('Failed to load scheduler settings:', error);
  }
}

async function updateSchedulerSettings() {
  const select = document.getElementById('scheduler-interval-select');
  if (!select) return;
  
  const val = select.value;
  try {
    const response = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: 'update_schedule',
        value: val
      })
    });
    
    if (!response.ok) throw new Error('Failed to update scheduler setting');
    showToast(`Scheduler update interval set to: ${val}`, 'success');
    fetchSchedulerLogs();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function fetchSchedulerLogs() {
  const container = document.getElementById('scheduler-logs-container');
  if (!container) return;
  
  try {
    const response = await fetch('/api/scheduler/logs');
    if (!response.ok) throw new Error('Failed to fetch scheduler logs');
    const logs = await response.json();
    
    if (!logs || logs.length === 0) {
      container.innerHTML = `<div class="text-[#4c566a] italic p-2">No scheduler execution logs.</div>`;
      return;
    }
    
    container.innerHTML = logs.map(l => {
      let statusColor = 'text-[#81a1c1]';
      if (l.status === 'success') statusColor = 'text-[#a3be8c]';
      if (l.status === 'error') statusColor = 'text-[#bf616a]';
      
      return `
        <div class="border-b border-[#4c566a]/20 pb-1.5 mb-1.5 last:border-0 last:pb-0 font-mono text-[10px]">
          <div class="flex justify-between text-[8px] text-[#4c566a]">
            <span>${l.created_at}</span>
            <span class="${statusColor} font-bold uppercase">${l.status}</span>
          </div>
          <div class="text-[#e5e9f0] mt-0.5">
            <span class="text-[#88c0d0] font-bold">[${escapeHTML(l.model_name)}]</span> ${escapeHTML(l.message)}
          </div>
        </div>
      `;
    }).join('');
  } catch (error) {
    console.error('Failed to load scheduler logs:', error);
  }
}

async function triggerSchedulerCheckNow() {
  const btn = document.getElementById('scheduler-check-btn');
  if (btn) btn.disabled = true;
  
  try {
    const response = await fetch('/api/scheduler/check', { method: 'POST' });
    if (!response.ok) throw new Error('Failed to trigger update check');
    
    showToast('Background model update check triggered', 'success');
    
    setTimeout(fetchSchedulerLogs, 1000);
    setTimeout(fetchSchedulerLogs, 3000);
    setTimeout(fetchSchedulerLogs, 5000);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// --- CONTEXT COMPRESSION ---

async function triggerManualCompression() {
  if (!activeChatId) {
    showToast('No active chat session selected', 'warning');
    return;
  }
  
  const btn = document.getElementById('ctx-compress-btn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-circle-notch animate-spin mr-1"></i> COMPRESSING...`;
  }
  
  try {
    const response = await fetch(`/api/chats/${activeChatId}/compress`, {
      method: 'POST'
    });
    
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to compress chat');
    }
    
    showToast('Chat context compressed with AI summary', 'success');
    await switchChatSession(activeChatId);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = 'COMPRESS';
    }
  }
}

// --- MODEL CAPABILITY DETECTION ---

/**
 * Returns array of capability strings for a model object.
 * Capabilities: 'vision', 'embedding', 'llm'
 */
function getModelCapabilities(model) {
  const caps = [];
  const families = (model.details && model.details.families) || [];
  const name = (model.name || '').toLowerCase();

  // Vision: Ollama sets 'clip' family for multimodal models
  if (families.some(f => f === 'clip') ||
      /llava|gemma3|minicpm[\-_]v|bakllava|moondream|cogvlm|internvl|vision|qwen.*vl|phi.*vision|pixtral/.test(name)) {
    caps.push('vision');
  }
  // Embedding: Ollama sets 'bert' / 'nomic-bert' families for embedding models
  if (families.some(f => /bert/.test(f)) ||
      /embed|nomic|mxbai|bge[-_]|e5[-_]|minilm|all-minilm|gte[-_]/.test(name)) {
    caps.push('embedding');
  }
  // Anything that isn't a pure embedding model can run standard/reasoning/longctx
  if (!caps.includes('embedding')) {
    caps.push('llm');
  }
  return caps;
}

// --- INFERENCE BENCHMARKER ---

let benchmarkEventSource = null;
let benchmarkStartTime   = null;
let currentBenchmarkType = 'standard';
let currentLbFilter      = 'all';
let currentScoreFilter   = 'all'; // grade filter: 'S'|'A'|'B'|'C'|'F'|'all'

// Benchmark model-select filters
let benchUntestedFilter  = false;
let benchParamSliderIdx  = 7;   // index into PARAM_STEPS; 7 = All
const PARAM_STEPS  = [0.5, 1, 3, 7, 13, 30, 70, Infinity];
const PARAM_LABELS = ['≤0.5B', '≤1B', '≤3B', '≤7B', '≤13B', '≤30B', '≤70B', 'All'];
// Tested model names per benchmark type — populated from leaderboard fetch
const testedModelsByType = {}; // { standard: Set<name>, embedding: Set<name>, … }

const BENCH_TYPES = ['standard', 'vision', 'embedding', 'longctx', 'reasoning'];
const BENCH_TYPE_HINTS = {
  standard:  'Any LLM model — inference speed test',
  vision:    'Requires multimodal model (e.g. llava, gemma3, minicpm-v)',
  embedding: 'Requires embedding model (e.g. nomic-embed-text, mxbai-embed)',
  longctx:   'LLM with large context window recommended (≥8K)',
  reasoning: 'Any LLM — factual accuracy & math test',
};

// Compute letter score from raw benchmark metrics (S/A/B/C/F)
function autoScore(bType, tps, extra) {
  if (bType === 'embedding') {
    const cps = extra.chunks_per_sec || 0;
    if (cps >= 500) return 'S';
    if (cps >= 200) return 'A';
    if (cps >= 50)  return 'B';
    if (cps >= 10)  return 'C';
    return 'F';
  }
  if (bType === 'reasoning') {
    const acc = extra.accuracy_pct || 0;
    if (acc >= 90) return 'S';
    if (acc >= 75) return 'A';
    if (acc >= 55) return 'B';
    if (acc >= 35) return 'C';
    return 'F';
  }
  // standard / vision / longctx — TPS-based
  if (tps >= 80) return 'S';
  if (tps >= 50) return 'A';
  if (tps >= 25) return 'B';
  if (tps >= 8)  return 'C';
  return 'F';
}

// Highlight benchmark log lines with semantic, line-type-aware formatting.
// Matches against raw text for type detection; applies spans to HTML-escaped output.
function highlightBenchLog(rawText) {
  const s = escapeHTML(rawText);
  const t = rawText.replace(/^\s+/, ''); // trimmed raw, for type detection
  const lead = rawText.length - t.length; // number of leading spaces

  // Inline colour helpers — all accept already-safe HTML fragments
  const D  = x => `<span class="text-[#4c566a]">${x}</span>`;          // dim grey
  const W  = x => `<span class="text-[#d8dee9]">${x}</span>`;          // white-ish neutral
  const Cy = x => `<span class="text-[#88c0d0] font-bold">${x}</span>`; // cyan bold   (TTFT)
  const Gr = x => `<span class="text-[#a3be8c] font-bold">${x}</span>`; // green bold  (TPS)
  const Ye = x => `<span class="text-[#ebcb8b] font-bold">${x}</span>`; // yellow bold (ch/s)
  const Or = x => `<span class="text-[#d08770] font-bold">${x}</span>`; // orange bold (%, acc)
  const Re = x => `<span class="text-[#bf616a] font-bold">${x}</span>`; // red bold    (WRONG)
  const Pu = x => `<span class="text-[#b48ead] font-bold">${x}</span>`; // purple      (vision)
  const Bl = x => `<span class="text-[#81a1c1] font-bold">${x}</span>`; // soft-blue   (ctx)
  const q  = escapeHTML;                                                 // shorthand

  // ── 1. "Initializing TYPE benchmark for model..." ─────────────────────────
  {
    const m = t.match(/^Initializing\s+(\S+)\s+benchmark\s+for\s+(.+?)\.{0,3}$/i);
    if (m) {
      return D('Initializing ') + Bl(q(m[1])) + D(' benchmark for ') + W(q(m[2])) + D('...');
    }
  }

  // ── 2. "TYPE benchmark complete." ────────────────────────────────────────
  {
    const m = t.match(/^(\S+)\s+benchmark\s+complete\.$/i);
    if (m) {
      return D(Bl(q(m[1])) + D(' benchmark complete.'));
    }
  }

  // ── 3. 'Prompt 1/3: "text"' (standard) ───────────────────────────────────
  {
    const m = t.match(/^(Prompt\s+\d+\/\d+):\s*(.*)$/i);
    if (m) {
      return Bl(q(m[1])) + D(': ') + D(q(m[2]));
    }
  }

  // ── 4. "Vision prompt 1/2..." (vision) ───────────────────────────────────
  {
    const m = t.match(/^(Vision\s+prompt\s+\d+\/\d+)\.{0,3}$/i);
    if (m) {
      return Pu(q(m[1])) + D('...');
    }
  }

  // ── 5. "Q1/5: text" (reasoning) ──────────────────────────────────────────
  {
    const m = t.match(/^(Q\d+\/\d+):\s*(.+)$/i);
    if (m) {
      return Or(q(m[1])) + D(': ') + W(q(m[2]));
    }
  }

  // ── 6. "Running ~4K context window test (num_ctx=4096)..." (longctx) ─────
  {
    const m = t.match(/^Running\s+~([\w.]+)\s+context\s+window\s+test\s+\(num_ctx=(\d+)\)\.{0,3}$/i);
    if (m) {
      return D('Running ~') + Bl(q(m[1])) + D(' context window test ') + D('(') + D('num_ctx=') + `<span class="text-[#88c0d0]">${q(m[2])}</span>` + D(')...');
    }
  }

  // ── 7. "Embedding N chunks to measure throughput..." (embedding) ──────────
  {
    const m = t.match(/^Embedding\s+(\d+)\s+chunks\s+to\s+measure\s+throughput\.{0,3}$/i);
    if (m) {
      return D('Embedding ') + Ye(q(m[1])) + D(' chunks to measure throughput...');
    }
  }

  // ── 8. "Done: N chunks in Xs → Y ch/s, ~Z tokens/s, dim=D" (embedding) ───
  {
    const m = t.match(/^Done:\s+(\d+)\s+chunks\s+in\s+([\d.]+)s\s+[→]\s+([\d.]+)\s+chunks\/s,\s+~(\d+)\s+tokens\/s,\s+dim=(\d+)$/i);
    if (m) {
      return Gr('Done:') + ' ' +
             Ye(q(m[1])) + D(' chunks in ') + `<span class="text-[#88c0d0]">${q(m[2])}</span>` + D('s') +
             D(' → ') + Ye(q(m[3])) + D(' ch/s') +
             D('  ·  ~') + `<span class="text-[#a3be8c]">${q(m[4])}</span>` + D(' tok/s') +
             D('  ·  dim=') + D(q(m[5]));
    }
  }

  // ── 9. "  TTFT: 123ms, TPS: 45.2[, Latency: 234ms]" (standard/vision) ────
  {
    const m = t.match(/^TTFT:\s*([\d.]+)ms,\s*TPS:\s*([\d.]+)(?:,\s*Latency:\s*([\d.]+)ms)?$/i);
    if (m) {
      let out = D('TTFT: ') + Cy(q(m[1])) + D('ms') +
                D('  ·  TPS: ') + Gr(q(m[2]));
      if (m[3]) out += D('  ·  Latency: ') + `<span class="text-[#81a1c1]">${q(m[3])}</span>` + D('ms');
      return (lead ? D('  ') : '') + out;
    }
  }

  // ── 10. "  4K context → TTFT: 123ms, TPS: 45.2" (longctx result) ─────────
  {
    const m = t.match(/^([\w.]+)\s+context\s+[→]\s+TTFT:\s*([\d.]+)ms,\s*TPS:\s*([\d.]+)$/i);
    if (m) {
      return (lead ? D('  ') : '') +
             Bl(q(m[1])) + D(' context → ') +
             D('TTFT: ') + Cy(q(m[2])) + D('ms') +
             D('  ·  TPS: ') + Gr(q(m[3]));
    }
  }

  // ── 11. "  Answer: "X" — ✓ CORRECT / ✗ WRONG  (expected: "Y")" ───────────
  {
    if (/\bAnswer:/i.test(t)) {
      let out = s;
      out = out.replace(/(Answer:)/i,    (_, m) => D(m));
      out = out.replace(/(✓\s*CORRECT)/g, (_, m) => Gr(m));
      out = out.replace(/(✗\s*WRONG)/g,   (_, m) => Re(m));
      out = out.replace(/(\(expected:)/gi, (_, m) => D(m));
      return out;
    }
  }

  // ── 12. "Result: N/M correct (P%)" (reasoning) ────────────────────────────
  {
    const m = t.match(/^Result:\s*(\d+)\/(\d+)\s+correct\s+\(([\d.]+)%\)$/i);
    if (m) {
      const pass = parseFloat(m[3]) >= 55;
      const frac = q(m[1]) + '/' + q(m[2]);
      return Or('Result:') + ' ' + (pass ? Gr(frac) : Ye(frac)) + D(' correct ') +
             D('(') + (pass ? Gr(q(m[3]) + '%') : Ye(q(m[3]) + '%')) + D(')');
    }
  }

  // ── 13. Warning / error sub-lines ─────────────────────────────────────────
  {
    if (/(?:failed:|warning:|no tokens received)/i.test(t)) {
      return `<span class="text-[#ebcb8b]">  ⚠ ${q(t)}</span>`;
    }
  }

  // ── 14. Fallback: generic metric highlights on neutral grey ───────────────
  let out = s;
  out = out.replace(/\b(\d+\.?\d*)\s+(TPS)\b/g,            (_, n) => Gr(n) + D(' TPS'));
  out = out.replace(/\b(\d+\.?\d*)\s+(ch\/s|chunks\/s)\b/g, (_, n) => Ye(n) + D(' ch/s'));
  out = out.replace(/\b(\d+\.?\d*)(%)\b/g,                   (_, n) => Or(n) + D('%'));
  out = out.replace(/\b(\d+\.?\d*)\s*(ms)\b/g,               (_, n) => Cy(n) + D(' ms'));
  return W(out);
}

// Benchmark model select: filtered by capability
// Parse a parameter size string like "7B", "13.5B", "670M" → billions (float).
// Returns null for unknown/unparseable values.
function parseParamBillions(paramStr) {
  if (!paramStr || paramStr === '?' || paramStr === 'N/A') return null;
  const m = paramStr.trim().match(/^([\d.]+)\s*([BbMmKk])?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'B').toUpperCase();
  if (unit === 'M') return n / 1000;
  if (unit === 'K') return n / 1_000_000;
  return n; // B or bare number
}

function onBenchParamSlider(val) {
  benchParamSliderIdx = parseInt(val, 10);
  const label = document.getElementById('bench-param-label');
  if (label) label.textContent = PARAM_LABELS[benchParamSliderIdx] || 'All';
  populateBenchmarkModelSelect();
}

async function toggleUntestedFilter() {
  benchUntestedFilter = !benchUntestedFilter;
  const btn = document.getElementById('bench-untested-btn');
  if (btn) btn.classList.toggle('bench-type-btn-active', benchUntestedFilter);

  if (benchUntestedFilter) {
    // Fetch all benchmark groups to build a complete tested-models map
    try {
      const r = await fetch('/api/benchmarks/grouped?type=all');
      if (r.ok) {
        const d = await r.json();
        (d.groups || []).forEach(g => {
          if (!testedModelsByType[g.benchmark_type]) testedModelsByType[g.benchmark_type] = new Set();
          testedModelsByType[g.benchmark_type].add(g.model_name);
        });
      }
    } catch (_) { /* silently ignore — filter will just show all */ }
  }

  populateBenchmarkModelSelect();
}

function populateBenchmarkModelSelect() {
  const select = document.getElementById('benchmark-model-select');
  if (!select) return;

  // 1. Capability filter (existing)
  let filtered = models;
  if (currentBenchmarkType === 'vision') {
    filtered = models.filter(m => getModelCapabilities(m).includes('vision'));
  } else if (currentBenchmarkType === 'embedding') {
    filtered = models.filter(m => getModelCapabilities(m).includes('embedding'));
  } else {
    filtered = models.filter(m => getModelCapabilities(m).includes('llm'));
  }

  // 2. Untested filter
  if (benchUntestedFilter) {
    const tested = testedModelsByType[currentBenchmarkType] || new Set();
    filtered = filtered.filter(m => !tested.has(m.name));
  }

  // 3. Param size filter
  const maxParams = PARAM_STEPS[benchParamSliderIdx];
  if (maxParams !== Infinity) {
    filtered = filtered.filter(m => {
      const pb = parseParamBillions((m.details && m.details.parameter_size) || '');
      return pb === null || pb <= maxParams; // unknown size → always include
    });
  }

  if (filtered.length === 0) {
    const reason = benchUntestedFilter ? 'untested models' : 'compatible models';
    select.innerHTML = `<option value="">-- No ${reason} found --</option>`;
    return;
  }
  const currentSelected = select.value || getPref('neurollama-bench-model') || '';
  select.innerHTML = filtered.map(m => {
    const paramSize = (m.details && m.details.parameter_size) || '?';
    return `<option value="${m.name}">${m.name} (${paramSize})</option>`;
  }).join('');
  if (currentSelected && select.querySelector(`option[value="${CSS.escape(currentSelected)}"]`)) {
    select.value = currentSelected;
  }
}

function setBenchmarkType(type) {
  currentBenchmarkType = type;
  BENCH_TYPES.forEach(t => {
    const btn = document.getElementById(`bench-type-${t}`);
    if (btn) btn.classList.toggle('bench-type-btn-active', t === type);
  });
  const hint = document.getElementById('benchmark-type-hint');
  if (hint) hint.textContent = BENCH_TYPE_HINTS[type] || '';
  populateBenchmarkModelSelect();
}

function setLbFilter(filter) {
  currentLbFilter = filter;
  currentScoreFilter = 'all'; // clear grade filter when type changes
  setPref('neurollama-bench-filter', filter);
  const filters = ['all', ...BENCH_TYPES];
  filters.forEach(f => {
    const btn = document.getElementById(`lb-filter-${f}`);
    if (btn) btn.classList.toggle('bench-type-btn-active', f === filter);
  });
  fetchBenchmarks();
}

function setLbScoreFilter(grade) {
  // Toggle off if clicking the active grade
  currentScoreFilter = (currentScoreFilter === grade) ? 'all' : grade;
  fetchBenchmarks();
}

function restoreLbFilterUI() {
  // Restore filter button state
  const savedFilter = getPref('neurollama-bench-filter', 'all');
  currentLbFilter = savedFilter;
  const filters = ['all', ...BENCH_TYPES];
  filters.forEach(f => {
    const btn = document.getElementById(`lb-filter-${f}`);
    if (btn) btn.classList.toggle('bench-type-btn-active', f === savedFilter);
  });
  // Restore sort indicator
  document.querySelectorAll('[id^="sort-indicator-"]').forEach(el => {
    el.innerHTML = '<i class="fa-solid fa-sort text-[9px]"></i>';
    el.className = 'text-[#4c566a]';
  });
  const indicator = document.getElementById(`sort-indicator-${lbSortCol}`);
  if (indicator) {
    indicator.innerHTML = `<i class="fa-solid fa-sort-${lbSortDir === 'asc' ? 'up' : 'down'} text-[9px]"></i>`;
    indicator.className = 'text-[#88c0d0]';
  }
}

// Leaderboard sort state — persisted in DB preferences (restored in init after loadPreferences)
let lbSortCol = 'created_at';
let lbSortDir = 'desc';
const SCORE_ORDER = { S: 5, A: 4, B: 3, C: 2, F: 1 };

function setLbSort(col) {
  if (lbSortCol === col) {
    lbSortDir = lbSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    lbSortCol = col;
    lbSortDir = (col === 'model_name' || col === 'server_name') ? 'asc' : 'desc';
  }
  setPref('neurollama-bench-sort-col', lbSortCol);
  setPref('neurollama-bench-sort-dir', lbSortDir);
  // Update header sort indicators
  document.querySelectorAll('[id^="sort-indicator-"]').forEach(el => {
    el.innerHTML = '<i class="fa-solid fa-sort text-[9px]"></i>';
    el.className = 'text-[#4c566a]';
  });
  const indicator = document.getElementById(`sort-indicator-${col}`);
  if (indicator) {
    indicator.innerHTML = `<i class="fa-solid fa-sort-${lbSortDir === 'asc' ? 'up' : 'down'} text-[9px]"></i>`;
    indicator.className = 'text-[#88c0d0]';
  }
  fetchBenchmarks();
}

function setBenchmarkRunning(isRunning) {
  const runBtn = document.getElementById('run-benchmark-btn');
  const cancelBtn = document.getElementById('cancel-benchmark-btn');

  if (runBtn) {
    runBtn.disabled = isRunning;
    runBtn.innerHTML = isRunning
      ? '<span class="loading loading-spinner loading-xs mr-1.5"></span>Measuring'
      : '<i class="fa-solid fa-play mr-1.5"></i>Start Measurement';
  }
  if (cancelBtn) {
    cancelBtn.classList.toggle('hidden', !isRunning);
    cancelBtn.disabled = !isRunning;
  }
}

function startBenchmark() {
  const modelSelect = document.getElementById('benchmark-model-select');
  if (!modelSelect) return;
  
  const model = modelSelect.value;
  if (!model) {
    showToast('Please select a model to benchmark', 'warning');
    return;
  }
  
  const logContainer = document.getElementById('benchmark-log');
  
  setBenchmarkRunning(true);
  benchmarkStartTime = Date.now();
  if (logContainer) {
    // Show a connecting placeholder — the server's first SSEvent will be the real "Initializing…" line
    logContainer.innerHTML = `<div class="text-[#4c566a] italic text-[10px] animate-pulse">▌ Connecting to benchmark stream...</div>`;
  }

  if (benchmarkEventSource) {
    benchmarkEventSource.close();
  }

  const url = `/api/benchmarks/run?model=${encodeURIComponent(model)}&type=${encodeURIComponent(currentBenchmarkType)}`;
  benchmarkEventSource = new EventSource(url);

  benchmarkEventSource.addEventListener('status', (e) => {
    if (logContainer) {
      const div = document.createElement('div');
      div.className = 'py-0.5 border-b border-[#4c566a]/10 last:border-none';
      div.innerHTML = highlightBenchLog(e.data);
      logContainer.appendChild(div);
      logContainer.scrollTop = logContainer.scrollHeight;
    }
  });
  
  benchmarkEventSource.addEventListener('error', (e) => {
    if (logContainer) {
      const div = document.createElement('div');
      div.className = 'mt-1';
      div.innerHTML = `<span class="text-[#bf616a] font-bold">[ERROR]</span> <span class="text-[#bf616a]">${escapeHTML(e.data || 'Failed to complete benchmark runs.')}</span>`;
      logContainer.appendChild(div);
      logContainer.scrollTop = logContainer.scrollHeight;
    }
    benchmarkEventSource.close();
    benchmarkEventSource = null;
    setBenchmarkRunning(false);
    benchmarkStartTime = null;
    recordStreamFailure('benchmark', e.data || 'Failed to complete benchmark runs.', { model, node: activeServerLabel() });
    showToast('Benchmark run failed', 'error');
  });
  
  benchmarkEventSource.addEventListener('done', (e) => {
    try {
      const res = JSON.parse(e.data);
      let extra = {};
      try { extra = JSON.parse(res.extra_json || '{}'); } catch (_) {}
      const bType = res.benchmark_type || 'standard';

      // Compute elapsed duration
      const elapsedSec = benchmarkStartTime ? Math.round((Date.now() - benchmarkStartTime) / 1000) : null;
      const durationStr = elapsedSec != null
        ? (elapsedSec >= 60 ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s` : `${elapsedSec}s`)
        : '';

      if (logContainer) {
        // Separator line
        const sep = document.createElement('div');
        sep.className = 'my-2 border-t border-[#a3be8c]/20';
        logContainer.appendChild(sep);

        // Result summary
        const div = document.createElement('div');
        div.className = 'flex items-center gap-2 flex-wrap';
        let metricHtml = '';
        if (bType === 'embedding') {
          metricHtml = `<span class="text-[#4c566a]">ch/s</span> <span class="text-[#ebcb8b] font-bold text-sm">${(extra.chunks_per_sec || 0).toFixed(1)}</span>`;
        } else if (bType === 'reasoning') {
          metricHtml = `<span class="text-[#4c566a]">acc</span> <span class="text-[#d08770] font-bold text-sm">${(extra.accuracy_pct || 0).toFixed(0)}%</span>`;
        } else if (bType === 'longctx') {
          metricHtml = `<span class="text-[#4c566a]">TPS</span> <span class="text-[#a3be8c] font-bold text-sm">${res.tps.toFixed(1)}</span>` +
            (extra.degradation_pct != null ? ` <span class="text-[#4c566a]">·</span> <span class="text-[#d08770] text-[10px]">↓${extra.degradation_pct.toFixed(1)}% deg</span>` : '');
        } else {
          metricHtml = `<span class="text-[#4c566a]">TPS</span> <span class="text-[#a3be8c] font-bold text-sm">${res.tps.toFixed(1)}</span>` +
            `<span class="text-[#4c566a]">·</span> <span class="text-[#4c566a]">TTFT</span> <span class="text-[#88c0d0] font-bold">${res.ttft_ms.toFixed(0)}ms</span>`;
        }
        const computed = autoScore(bType, res.tps || 0, extra);
        const GRADE_CLS = { S:'text-[#a3be8c]', A:'text-[#88c0d0]', B:'text-[#8fbcbb]', C:'text-[#ebcb8b]', F:'text-[#bf616a]' };
        const gradeHtml = `<span class="border border-[#4c566a]/50 px-1.5 py-0.5 rounded text-[9px] font-bold ${GRADE_CLS[computed] || 'text-[#d8dee9]'}" title="Auto-scored">${computed}</span>`;
        const durHtml = durationStr ? `<span class="text-[#4c566a] text-[10px]">· ${escapeHTML(durationStr)}</span>` : '';
        div.innerHTML = `<span class="text-[#a3be8c] font-bold text-[10px] uppercase tracking-widest">✓ Complete</span> ${metricHtml} ${gradeHtml} ${durHtml}`;
        logContainer.appendChild(div);
        logContainer.scrollTop = logContainer.scrollHeight;
      }

      // Auto-score and persist immediately (grade was also displayed in the log banner above)
      const autoGrade = autoScore(bType, res.tps || 0, extra);
      if (res.id) {
        fetch(`/api/benchmarks/${res.id}/score`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ score: autoGrade, notes: 'auto' })
        }).catch(() => {});
      }

      showToast('Benchmark completed and saved to leaderboard!', 'success');
      fetchBenchmarks();
    } catch (err) {
      console.error(err);
    } finally {
      benchmarkEventSource.close();
      benchmarkEventSource = null;
      setBenchmarkRunning(false);
      benchmarkStartTime = null;
    }
  });
  
  benchmarkEventSource.onerror = (err) => {
    console.warn('Benchmark EventSource error:', err);
    benchmarkEventSource.close();
    benchmarkEventSource = null;
    setBenchmarkRunning(false);
    recordStreamFailure('benchmark', 'Connection to benchmark stream was interrupted.', { model, node: activeServerLabel() });
  };
}

function cancelBenchmark() {
  if (!benchmarkEventSource) return;
  benchmarkEventSource.close();
  benchmarkEventSource = null;
  setBenchmarkRunning(false);
  benchmarkStartTime = null;
  const logContainer = document.getElementById('benchmark-log');
  if (logContainer) {
    const div = document.createElement('div');
    div.className = 'mt-1';
    div.innerHTML = '<span class="text-[#ebcb8b] font-bold">[CANCELLED]</span> <span class="text-[#ebcb8b]">Benchmark stream stopped by user.</span>';
    logContainer.appendChild(div);
    logContainer.scrollTop = logContainer.scrollHeight;
  }
  showToast('Benchmark run stopped', 'warning');
}

async function fetchBenchmarks() {
  const tbody = document.getElementById('benchmark-leaderboard-body');
  if (!tbody) return;

  // All grouping, averaging, scoring, and stats are computed server-side.
  // This function only fetches and renders — no arithmetic here.
  const params = new URLSearchParams({
    type: currentLbFilter || 'all',
    sort: lbSortCol        || 'created_at',
    dir:  lbSortDir        || 'desc',
  });

  try {
    const response = await fetch(`/api/benchmarks/grouped?${params}`);
    if (!response.ok) throw new Error('Failed to fetch benchmark leaderboard');
    const data = await response.json();

    const allGroups = data.groups || [];
    const stats     = data.stats  || {};

    // Keep testedModelsByType current so the untested model filter stays accurate.
    // Only do a full refresh when the leaderboard is showing all types.
    if (!currentLbFilter || currentLbFilter === 'all') {
      BENCH_TYPES.forEach(t => { testedModelsByType[t] = new Set(); });
      allGroups.forEach(g => {
        if (!testedModelsByType[g.benchmark_type]) testedModelsByType[g.benchmark_type] = new Set();
        testedModelsByType[g.benchmark_type].add(g.model_name);
      });
      if (benchUntestedFilter) populateBenchmarkModelSelect();
    }

    // Client-side score-grade filter (applied on top of the server-side type filter)
    const groupList = (currentScoreFilter && currentScoreFilter !== 'all')
      ? allGroups.filter(g => g.display_score === currentScoreFilter)
      : allGroups;

    // ── Empty state ──────────────────────────────────────────────────────────
    if (groupList.length === 0) {
      const typeLabel  = (currentLbFilter && currentLbFilter !== 'all') ? ` for type "${currentLbFilter}"` : '';
      const scoreLabel = (currentScoreFilter && currentScoreFilter !== 'all') ? ` with grade "${currentScoreFilter}"` : '';
      tbody.innerHTML = `
        <tr>
          <td colspan="7" class="text-center py-12 text-[#4c566a] italic">
            No benchmark runs recorded${typeLabel}${scoreLabel}. Select a model on the left to begin.
          </td>
        </tr>
      `;
      const statsBar = document.getElementById('lb-stats-bar');
      if (statsBar) statsBar.innerHTML = '';
      return;
    }

    // ── Stats bar (data already computed by server) ──────────────────────────
    const statsBar = document.getElementById('lb-stats-bar');
    if (statsBar && stats.total_runs > 0) {
      const TYPE_META = {
        standard:  { short:'STD', cls:'text-[#88c0d0]', border:'border-[#88c0d0]/40', bg:'bg-[#88c0d0]/8'  },
        vision:    { short:'VIS', cls:'text-[#b48ead]', border:'border-[#b48ead]/50', bg:'bg-[#b48ead]/8'  },
        embedding: { short:'EMB', cls:'text-[#ebcb8b]', border:'border-[#ebcb8b]/40', bg:'bg-[#ebcb8b]/8'  },
        longctx:   { short:'CTX', cls:'text-[#a3be8c]', border:'border-[#a3be8c]/40', bg:'bg-[#a3be8c]/8'  },
        reasoning: { short:'RSN', cls:'text-[#d08770]', border:'border-[#d08770]/50', bg:'bg-[#d08770]/8'  },
      };
      const SCORE_BADGE = {
        S: 'text-[#a3be8c]', A: 'text-[#88c0d0]',
        B: 'text-[#8fbcbb]', C: 'text-[#ebcb8b]', F: 'text-[#bf616a]',
      };

      // Score distribution pills — clickable to filter by grade
      const scoreDist = stats.score_distribution || {};
      const distParts = ['S','A','B','C','F']
        .filter(sc => (scoreDist[sc] || 0) > 0)
        .map(sc => {
          const isActive = currentScoreFilter === sc;
          const col = SCORE_BADGE[sc] || 'text-[#4c566a]';
          const activeCls = isActive
            ? 'ring-1 ring-current bg-current/15 rounded px-1 py-0.5'
            : 'rounded px-1 py-0.5 hover:bg-current/10 hover:rounded';
          return `<button onclick="setLbScoreFilter('${sc}')" class="${col} font-mono text-[10px] cursor-pointer transition-colors ${activeCls}" title="${isActive ? 'Clear' : 'Filter by'} grade ${sc}">${sc}:${scoreDist[sc]}</button>`;
        })
        .join('<span class="text-[#4c566a]/40 mx-0.5">·</span>');

      // Type-best cards — one per benchmark type, wider with readable model names
      const bestCards = (stats.type_bests || []).map(tb => {
        const meta = TYPE_META[tb.benchmark_type] || { short: tb.benchmark_type.slice(0,3).toUpperCase(), cls:'text-[#4c566a]', border:'border-[#4c566a]/40', bg:'bg-[#4c566a]/8' };
        const modelShort = tb.model_name.split(':')[0];
        return `
          <div class="flex items-center gap-1.5 ${meta.bg} border ${meta.border} rounded-md px-2 py-1 shrink-0">
            <span class="${meta.cls} border ${meta.border} text-[8px] font-mono font-bold px-1 py-0.5 rounded">${meta.short}</span>
            <span class="text-[#d8dee9] text-[10px] font-mono font-semibold max-w-[150px] truncate" title="${escapeHTML(tb.model_name)}">${escapeHTML(modelShort)}</span>
            <span class="${meta.cls} text-[10px] font-bold font-mono whitespace-nowrap">${escapeHTML(tb.label)}</span>
          </div>`;
      }).join('');

      statsBar.innerHTML = `
        <div class="flex items-center gap-3 text-[10px] font-mono text-[#4c566a] mb-2">
          <span class="flex items-center gap-1"><i class="fa-solid fa-database text-[9px]"></i> ${stats.total_runs} run${stats.total_runs !== 1 ? 's' : ''}</span>
          <span class="text-[#4c566a]/40">|</span>
          <span>${stats.unique_models} model${stats.unique_models !== 1 ? 's' : ''}</span>
          ${distParts ? `<span class="text-[#4c566a]/40">|</span><span class="flex items-center gap-1">${distParts}</span>` : ''}
        </div>
        ${bestCards ? `<div class="flex flex-wrap gap-2">${bestCards}</div>` : ''}
      `;
    }

    // ── Rendering helpers (presentation only — no computation) ───────────────

    const TYPE_BADGE = {
      standard:  { label: 'STD', cls: 'text-[#88c0d0] border-[#88c0d0]' },
      vision:    { label: 'VIS', cls: 'text-[#b48ead] border-[#b48ead]' },
      embedding: { label: 'EMB', cls: 'text-[#ebcb8b] border-[#ebcb8b]' },
      longctx:   { label: 'CTX', cls: 'text-[#a3be8c] border-[#a3be8c]' },
      reasoning: { label: 'RSN', cls: 'text-[#d08770] border-[#d08770]' },
    };

    function scoreBadgeClass(score) {
      if      (score === 'S')                  return 'bg-[#a3be8c]/25 text-[#a3be8c] border-[#a3be8c]';
      else if (score === 'A' || score === 'B') return 'bg-[#88c0d0]/25 text-[#88c0d0] border-[#88c0d0]';
      else if (score === 'C')                  return 'bg-[#ebcb8b]/25 text-[#ebcb8b] border-[#ebcb8b]';
      else if (score === 'F')                  return 'bg-[#bf616a]/25 text-[#bf616a] border-[#bf616a]';
      else                                     return 'bg-[#4c566a]/25 text-[#d8dee9] border-[#4c566a]';
    }

    // Build the three metric TD cells for one run row.
    // sr is either a full Benchmark run or a BenchmarkSummaryRun (same field names).
    function metricCells(sr, bType) {
      let extra = {};
      try { extra = JSON.parse(sr.extra_json || '{}'); } catch (_) {}
      const isAvg = !!sr.is_avg;
      let ttftCell, metricCell, latCell;

      if (bType === 'embedding') {
        const cps = extra.chunks_per_sec != null ? extra.chunks_per_sec.toFixed(1) : '—';
        const rng = (isAvg && sr.min_chunks_per_sec != null && sr.max_chunks_per_sec != null && sr.max_chunks_per_sec !== sr.min_chunks_per_sec)
          ? `<span class="text-[9px] text-[#4c566a] font-normal ml-1">±${((sr.max_chunks_per_sec - sr.min_chunks_per_sec) / 2).toFixed(1)}</span>` : '';
        ttftCell   = `<td class="text-center text-[#4c566a]">—</td>`;
        metricCell = `<td class="text-center font-bold text-[#ebcb8b]">${cps}${rng} <span class="text-[9px] text-[#4c566a] font-normal">ch/s</span></td>`;
        latCell    = `<td class="text-center text-[#4c566a]">—</td>`;
      } else if (bType === 'reasoning') {
        const acc = extra.accuracy_pct != null ? extra.accuracy_pct.toFixed(0) + '%' : '—';
        const rng = (isAvg && sr.min_accuracy_pct != null && sr.max_accuracy_pct != null && sr.max_accuracy_pct !== sr.min_accuracy_pct)
          ? `<span class="text-[9px] text-[#4c566a] font-normal ml-1">±${((sr.max_accuracy_pct - sr.min_accuracy_pct) / 2).toFixed(1)}%</span>` : '';
        ttftCell   = `<td class="text-center text-[#4c566a]">—</td>`;
        metricCell = `<td class="text-center font-bold text-[#a3be8c]">${acc}${rng} <span class="text-[9px] text-[#4c566a] font-normal">acc</span></td>`;
        latCell    = `<td class="text-center">${(sr.avg_latency_ms || 0).toFixed(0)} ms</td>`;
      } else if (bType === 'longctx') {
        const deg    = extra.degradation_pct != null ? extra.degradation_pct.toFixed(1) + '%' : '';
        const degHtml = deg ? ` <span class="text-[9px] text-[#bf616a] font-normal">↓${deg}</span>` : '';
        const rng    = (isAvg && sr.min_tps != null && sr.max_tps != null && sr.max_tps !== sr.min_tps)
          ? `<span class="text-[9px] text-[#4c566a] font-normal ml-1">±${((sr.max_tps - sr.min_tps) / 2).toFixed(1)}</span>` : '';
        ttftCell   = `<td class="text-center">${(sr.ttft_ms || 0).toFixed(1)} ms</td>`;
        metricCell = `<td class="text-center font-bold text-[#88c0d0]">${(sr.tps || 0).toFixed(1)}${degHtml}${rng}</td>`;
        latCell    = `<td class="text-center">${(sr.avg_latency_ms || 0).toFixed(0)} ms</td>`;
      } else {
        // standard / vision
        const rng = (isAvg && sr.min_tps != null && sr.max_tps != null && sr.max_tps !== sr.min_tps)
          ? `<span class="text-[9px] text-[#4c566a] font-normal ml-1">±${((sr.max_tps - sr.min_tps) / 2).toFixed(1)}</span>` : '';
        ttftCell   = `<td class="text-center">${(sr.ttft_ms || 0).toFixed(1)} ms</td>`;
        metricCell = `<td class="text-center font-bold text-[#88c0d0]">${(sr.tps || 0).toFixed(1)}${rng} <span class="text-[9px] text-[#4c566a] font-normal">TPS</span></td>`;
        latCell    = `<td class="text-center">${(sr.avg_latency_ms || 0).toFixed(0)} ms</td>`;
      }
      return { ttftCell, metricCell, latCell };
    }

    // ── Build table rows ─────────────────────────────────────────────────────
    let html = '';

    groupList.forEach((group, groupIdx) => {
      const bType     = group.benchmark_type || 'standard';
      const gkey      = `grp-${groupIdx}`;
      const multiRun  = group.run_count > 1;

      // Server display: prefer server_name, fall back to hostname
      let serverDisplay = group.server_name || '';
      if (!serverDisplay && group.server_url) {
        try { serverDisplay = new URL(group.server_url).hostname; } catch (_) { serverDisplay = group.server_url; }
      }

      const tb            = TYPE_BADGE[bType] || { label: bType.toUpperCase().slice(0, 3), cls: 'text-[#4c566a] border-[#4c566a]' };
      const typeBadgeHtml = `<span class="border px-1.5 rounded text-[8px] font-bold font-mono ${tb.cls}">${tb.label}</span>`;

      // Summary row uses pre-computed summary_run from server
      const { ttftCell, metricCell, latCell } = metricCells(group.summary_run, bType);

      const displayScore = group.display_score || 'F';
      const scoreClass   = scoreBadgeClass(displayScore);
      const autoBadge    = group.is_auto_score
        ? `<span class="text-[8px] text-[#4c566a] font-mono ml-0.5" title="Auto-scored from metrics">auto</span>`
        : '';

      const runsBadge = multiRun
        ? `<span class="ml-1 bg-[#3b4252] border border-[#4c566a] text-[#8fbcbb] text-[8px] font-mono px-1.5 rounded-full">${group.run_count}×</span>`
        : '';
      const expandBtn = multiRun
        ? `<button onclick="event.stopPropagation();toggleBenchGroup('${gkey}')" id="expand-btn-${gkey}"
                   title="Show individual runs"
                   class="btn btn-xs btn-ghost text-[#4c566a] hover:text-[#88c0d0] hover:bg-[#88c0d0]/15 p-1">
             <i id="expand-icon-${gkey}" class="fa-solid fa-chevron-down text-[10px] transition-transform duration-150"></i>
           </button>`
        : '';

      const userNotes = (group.latest_notes && group.latest_notes !== 'auto') ? group.latest_notes : '';
      const noteHtml  = (userNotes && !multiRun)
        ? `<div class="text-[10px] text-[#4c566a] mt-0.5 max-w-[200px] truncate" title="${escapeHTML(userNotes)}">${escapeHTML(userNotes)}</div>`
        : '';

      const rateNotes   = userNotes || '';
      const singleActions = !multiRun ? `
              <button onclick="openScoreModal(${group.latest_id}, '${escapeHTML(displayScore)}', '${escapeHTML(rateNotes)}')"
                      class="btn btn-xs btn-neutral border-[#4c566a] font-tech text-[9px] px-2">RATE</button>
              <button onclick="deleteBenchmark(${group.latest_id})" class="btn btn-xs btn-ghost text-[#bf616a] hover:bg-[#bf616a]/15 p-1">
                <i class="fa-solid fa-trash-can text-[10px]"></i>
              </button>` : '';

      html += `
        <tr class="hover:bg-[#3b4252]/20 border-b border-[#4c566a]/20 transition-colors${multiRun ? ' cursor-pointer' : ''}"
            ${multiRun ? `onclick="toggleBenchGroup('${gkey}')"` : ''}>
          <td class="py-3 text-left font-mono overflow-hidden">
            <div class="flex items-center gap-1.5 overflow-hidden">
              ${typeBadgeHtml}
              <span class="font-bold text-[#e5e9f0] truncate min-w-0" title="${escapeHTML(group.model_name)}">${escapeHTML(group.model_name)}</span>
              ${runsBadge}
            </div>
            ${noteHtml}
          </td>
          <td class="py-3 text-left font-mono text-[11px] overflow-hidden">
            <div class="text-[#88c0d0] font-bold truncate" title="${escapeHTML(serverDisplay || '')}">${escapeHTML(serverDisplay || '—')}</div>
            <div class="text-[9px] text-[#4c566a] truncate flex items-center gap-1.5">
              ${group.ollama_version ? `<span class="bg-[#3b4252] px-1.5 rounded" title="Ollama version">v${escapeHTML(group.ollama_version)}</span>` : ''}
              <span class="truncate" title="${escapeHTML(group.server_url || '')}">${escapeHTML(group.server_url || '')}</span>
            </div>
          </td>
          ${ttftCell}
          ${metricCell}
          ${latCell}
          <td class="text-center">
            <span class="border px-2 py-0.5 rounded text-[9px] font-bold ${scoreClass}">${escapeHTML(displayScore)}</span>${autoBadge}
          </td>
          <td class="text-right">
            <div class="flex gap-1 justify-end" onclick="event.stopPropagation()">
              <button onclick="retestBenchmark('${escapeHTML(group.model_name)}', '${escapeHTML(bType)}')"
                      title="Re-run this benchmark"
                      class="btn btn-xs btn-ghost text-[#88c0d0] hover:bg-[#88c0d0]/15 p-1">
                <i class="fa-solid fa-rotate-right text-[10px]"></i>
              </button>
              ${singleActions}
              ${expandBtn}
            </div>
          </td>
        </tr>
      `;

      // Sub-rows for individual runs (multi-run only, collapsed by default)
      if (multiRun) {
        (group.runs || []).forEach((run, idx) => {
          // display_score and is_auto_score are pre-resolved server-side for every run.
          const runDisplayScore = run.display_score || 'F';
          const runIsAutoScore  = !!run.is_auto_score;
          const runScCls        = scoreBadgeClass(runDisplayScore);
          const runAutoBadge    = runIsAutoScore ? `<span class="text-[8px] text-[#4c566a] font-mono ml-0.5">auto</span>` : '';
          const runUserNotes = (run.notes && run.notes !== 'auto') ? run.notes : '';
          const { ttftCell: rt, metricCell: rm, latCell: rl } = metricCells(run, bType);
          const runDate  = run.created_at
            ? new Date(run.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
            : '—';
          const newestTag = idx === 0
            ? `<span class="text-[8px] text-[#a3be8c] font-bold uppercase tracking-wide bg-[#a3be8c]/15 px-1.5 rounded ml-2">latest</span>`
            : '';
          const verTag = run.ollama_version
            ? `<span class="text-[8px] text-[#4c566a] font-mono ml-1.5 bg-[#3b4252] px-1.5 rounded" title="Ollama version">v${escapeHTML(run.ollama_version)}</span>`
            : '';

          html += `
            <tr id="sub-${gkey}-${idx}" data-group="${gkey}"
                class="bench-sub-row bg-[#2e3440]/60 border-b border-[#4c566a]/10 text-[11px] hidden">
              <td class="py-2 pl-8 font-mono text-[#4c566a]">
                ${escapeHTML(runDate)}${newestTag}${verTag}
              </td>
              <td class="text-[10px] text-[#4c566a]">run #${run.id}</td>
              ${rt}
              ${rm}
              ${rl}
              <td class="text-center">
                <span class="border px-2 py-0.5 rounded text-[9px] font-bold ${runScCls}">${escapeHTML(runDisplayScore)}</span>${runAutoBadge}
              </td>
              <td class="text-right">
                <div class="flex gap-1 justify-end">
                  <button onclick="openScoreModal(${run.id}, '${escapeHTML(runDisplayScore)}', '${escapeHTML(runUserNotes)}')"
                          class="btn btn-xs btn-neutral border-[#4c566a] font-tech text-[9px] px-2">RATE</button>
                  <button onclick="deleteBenchmark(${run.id})" class="btn btn-xs btn-ghost text-[#bf616a] hover:bg-[#bf616a]/15 p-1">
                    <i class="fa-solid fa-trash-can text-[10px]"></i>
                  </button>
                </div>
              </td>
            </tr>
          `;
        });
      }
    });

    tbody.innerHTML = html;
  } catch (error) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center py-8 text-[#bf616a] italic">
          Failed to load leaderboard: ${error.message}
        </td>
      </tr>
    `;
  }
}

// Toggle visibility of individual run sub-rows for a benchmark group
function toggleBenchGroup(gkey) {
  const rows = document.querySelectorAll(`[data-group="${gkey}"]`);
  const icon = document.getElementById(`expand-icon-${gkey}`);
  const isExpanded = [...rows].some(r => !r.classList.contains('hidden'));
  rows.forEach(r => r.classList.toggle('hidden', isExpanded));
  if (icon) icon.style.transform = isExpanded ? '' : 'rotate(180deg)';
}

function retestBenchmark(modelName, benchType) {
  // Switch to benchmark workspace
  switchWorkspace('benchmark');

  // Set the benchmark type buttons + update state
  setBenchmarkType(benchType || 'standard');

  // After the model select is (re)populated, pick the right model then auto-start
  setTimeout(() => {
    const sel = document.getElementById('benchmark-model-select');
    if (sel) {
      // Try exact match first, then base-name prefix match
      const exact = Array.from(sel.options).find(o => o.value === modelName);
      const prefix = Array.from(sel.options).find(o => o.value.startsWith(modelName.split(':')[0]));
      const match = exact || prefix;
      if (match) {
        sel.value = match.value;
      }
    }
    startBenchmark();
  }, 100);
}

function openScoreModal(id, currentScore, currentNotes) {
  const modal = document.getElementById('benchmark-score-modal');
  if (!modal) return;
  
  document.getElementById('modal-benchmark-id').value = id;
  
  const scoreSelect = document.getElementById('modal-score-select');
  if (scoreSelect) {
    if (currentScore === 'Pending' || !currentScore) {
      scoreSelect.value = 'S (Phenomenal)';
    } else {
      scoreSelect.value = currentScore;
    }
  }
  
  const notesArea = document.getElementById('modal-notes-area');
  if (notesArea) {
    notesArea.value = currentNotes === 'Pending' ? '' : currentNotes;
  }
  
  modal.showModal();
}

function closeScoreModal() {
  const modal = document.getElementById('benchmark-score-modal');
  if (modal) {
    modal.close();
  }
}

async function saveBenchmarkScore() {
  const id = document.getElementById('modal-benchmark-id').value;
  const score = document.getElementById('modal-score-select').value;
  const notes = document.getElementById('modal-notes-area').value;
  
  try {
    const response = await fetch(`/api/benchmarks/${id}/score`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ score, notes })
    });
    
    if (!response.ok) throw new Error('Failed to save score');
    
    showToast('Benchmark rating saved successfully', 'success');
    closeScoreModal();
    fetchBenchmarks();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function deleteBenchmark(id) {
  if (!confirm('Are you sure you want to delete this benchmark record?')) return;
  
  try {
    const response = await fetch(`/api/benchmarks/${id}`, {
      method: 'DELETE'
    });
    
    if (!response.ok) throw new Error('Failed to delete benchmark record');
    
    showToast('Benchmark record deleted', 'warning');
    fetchBenchmarks();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function exportBenchmarksCSV() {
  // CSV is built and streamed server-side — the browser just triggers a download.
  const type = (currentLbFilter && currentLbFilter !== 'all') ? `?type=${encodeURIComponent(currentLbFilter)}` : '';
  window.open(`/api/benchmarks/export.csv${type}`, '_blank');
}

// --- HYPERPARAMETER OPTIMIZER CONTROLLERS ---

function switchBenchmarkSubtab(tab) {
  const tabs = ['standard', 'optimizer', 'nodevnode'];
  tabs.forEach(t => {
    const btn = document.getElementById(`benchmark-subtab-${t}`);
    const container = document.getElementById(`benchmark-${t}-container`);
    if (btn) btn.classList.toggle('bench-subtab-active', t === tab);
    if (container) container.classList.toggle('hidden', t !== tab);
  });
  if (tab === 'optimizer') loadOptimizerHistory();
  if (tab === 'nodevnode') loadNvnPanel();
}

// ── Node vs Node ─────────────────────────────────────────────────────────────

let nvnType         = 'standard';
let nvnES           = null;   // EventSource
let nvnModels       = {};     // { nodeId: [model objects] }
let nvnFilterNodeA  = false;  // when true, model list is restricted to Node A's models
let nvnFilterBoth   = false;  // when true, model list is restricted to models on BOTH A and B

function setNvnType(type) {
  nvnType = type;
  ['standard','vision','embedding','longctx','reasoning'].forEach(t => {
    const btn = document.getElementById(`nvn-type-${t}`);
    if (btn) btn.classList.toggle('bench-type-btn-active', t === type);
  });
}

function _setNvnFilterBadge(id, active) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.classList.toggle('border-[#88c0d0]', active);
  btn.classList.toggle('text-[#88c0d0]',   active);
  btn.classList.toggle('bg-[#88c0d0]/10',  active);
  btn.classList.toggle('border-[#4c566a]', !active);
  btn.classList.toggle('text-[#4c566a]',   !active);
}

function toggleNvnNodeAFilter() {
  nvnFilterNodeA = !nvnFilterNodeA;
  if (nvnFilterNodeA) { nvnFilterBoth = false; _setNvnFilterBadge('nvn-filter-both-btn', false); }
  _setNvnFilterBadge('nvn-filter-node-a-btn', nvnFilterNodeA);
  populateNvnModelSelect();
}

function toggleNvnBothFilter() {
  nvnFilterBoth = !nvnFilterBoth;
  if (nvnFilterBoth) { nvnFilterNodeA = false; _setNvnFilterBadge('nvn-filter-node-a-btn', false); }
  _setNvnFilterBadge('nvn-filter-both-btn', nvnFilterBoth);
  populateNvnModelSelect();
}

async function loadNvnPanel() {
  // Populate node selects from the global servers list
  const nodeA = document.getElementById('nvn-node-a');
  const nodeB = document.getElementById('nvn-node-b');
  if (!nodeA || !nodeB) return;

  const opts = servers.map(s =>
    `<option value="${escapeHTML(s.id)}">${escapeHTML(s.name)}</option>`
  ).join('');
  nodeA.innerHTML = '<option value="">-- Select node --</option>' + opts;
  nodeB.innerHTML = '<option value="">-- Select node --</option>' + opts;

  // Pre-select active server as Node A if possible
  const active = servers.find(s => s.isActive);
  if (active) nodeA.value = active.id;
  // Pre-select Node B: prefer an online non-active node, fall back to any non-active
  const nodeForB = servers.find(s => !s.isActive && s.status === 'online')
                || servers.find(s => !s.isActive);
  if (nodeForB) nodeB.value = nodeForB.id;

  // Fetch model lists for all nodes so we can show availability
  await refreshNvnModels();
  populateNvnModelSelect();
  updateNvnAvailability();

  // Attach searchable select to nvn-model-select if not already done
  const modelSel = document.getElementById('nvn-model-select');
  if (modelSel && !modelSel._ssInit) makeSearchableSelect(modelSel);

  // Load the win/loss leaderboard
  loadNvnLeaderboard();
}

async function refreshNvnModels() {
  try {
    const r = await fetch('/api/node-models?ids=all');
    if (!r.ok) return;
    const d = await r.json();
    nvnModels = d.servers || {};
  } catch (_) {}
}

function populateNvnModelSelect() {
  const select = document.getElementById('nvn-model-select');
  if (!select) return;

  const seen = new Map(); // name → paramSize
  const nodeAId = document.getElementById('nvn-node-a')?.value;
  const nodeBId = document.getElementById('nvn-node-b')?.value;

  if (nvnFilterBoth) {
    // Intersection: only models present on BOTH Node A and Node B
    const nodeAList = (nodeAId && nvnModels[nodeAId]) || [];
    const nodeBNames = new Set(((nodeBId && nvnModels[nodeBId]) || []).map(m => m.name));
    nodeAList.forEach(m => {
      if (nodeBNames.has(m.name) && !seen.has(m.name)) {
        seen.set(m.name, (m.details && m.details.parameter_size) || '?');
      }
    });
  } else if (nvnFilterNodeA) {
    // Only include models present on the currently selected Node A
    const nodeAList = (nodeAId && nvnModels[nodeAId]) || [];
    nodeAList.forEach(m => {
      if (!seen.has(m.name)) {
        seen.set(m.name, (m.details && m.details.parameter_size) || '?');
      }
    });
  } else {
    // Union of all models across all cached nodes
    Object.values(nvnModels).forEach(modelList => {
      (modelList || []).forEach(m => {
        if (!seen.has(m.name)) {
          seen.set(m.name, (m.details && m.details.parameter_size) || '?');
        }
      });
    });
  }

  // Fall back to active-server models array if nothing loaded yet
  if (seen.size === 0 && !nvnFilterNodeA && !nvnFilterBoth) {
    models.forEach(m => {
      const param = (m.details && m.details.parameter_size) || '?';
      seen.set(m.name, param);
    });
  }

  const emptyMsg = nvnFilterBoth   ? '— No shared models on A & B —'
                 : nvnFilterNodeA  ? '— No models on Node A —'
                 :                   '— No models found —';

  const sorted = [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const prev = select.value;
  select.innerHTML = sorted.length
    ? sorted.map(([name, param]) =>
        `<option value="${escapeHTML(name)}">${escapeHTML(name)} (${escapeHTML(param)})</option>`
      ).join('')
    : `<option value="">${emptyMsg}</option>`;
  if (prev && select.querySelector(`option[value="${CSS.escape(prev)}"]`)) select.value = prev;
  updateNvnAvailability();
}

function nvnNodeHasModel(nodeId, modelName) {
  const list = nvnModels[nodeId] || [];
  return list.some(m => m.name === modelName);
}

function updateNvnAvailability() {
  const model  = document.getElementById('nvn-model-select')?.value;
  const nodeAId = document.getElementById('nvn-node-a')?.value;
  const nodeBId = document.getElementById('nvn-node-b')?.value;

  const setAvail = (elId, nodeId) => {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!nodeId || !model) { el.textContent = '—'; el.className = 'text-[10px] font-mono shrink-0 w-5 text-center text-[#4c566a]'; return; }
    const has = nvnNodeHasModel(nodeId, model);
    el.textContent = has ? '✓' : '✗';
    el.className = `text-[10px] font-mono shrink-0 w-5 text-center ${has ? 'text-[#a3be8c]' : 'text-[#bf616a]'}`;
  };
  setAvail('nvn-avail-a', nodeAId);
  setAvail('nvn-avail-b', nodeBId);
}

function nvnLog(node, msg) {
  const log = document.getElementById('nvn-log');
  if (!log) return;
  if (log.querySelector('.italic')) log.innerHTML = ''; // clear placeholder

  const nodeColors = { 'Node A': 'text-[#88c0d0]', 'Node B': 'text-[#a3be8c]' };
  const nodeClass  = nodeColors[node] || 'text-[#8fbcbb]';

  const line = document.createElement('div');
  line.className = 'flex items-start gap-1.5 leading-snug';
  line.innerHTML = node
    ? `<span class="${nodeClass} font-bold shrink-0 w-[52px]">[${node.replace('Node ', '')}]</span><span class="text-[#d8dee9]">${escapeHTML(msg)}</span>`
    : `<span class="text-[#4c566a] italic col-span-2">${escapeHTML(msg)}</span>`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function startNodeVsNode() {
  const model   = document.getElementById('nvn-model-select')?.value;
  const nodeAId = document.getElementById('nvn-node-a')?.value;
  const nodeBId = document.getElementById('nvn-node-b')?.value;
  const autoPull = document.getElementById('nvn-auto-pull')?.checked;

  if (!model)   { showToast('Select a model', 'warning'); return; }
  if (!nodeAId) { showToast('Select Node A', 'warning'); return; }
  if (!nodeBId) { showToast('Select Node B', 'warning'); return; }
  if (nodeAId === nodeBId) { showToast('Node A and Node B must be different', 'warning'); return; }

  if (nvnES) { nvnES.close(); nvnES = null; }

  const log = document.getElementById('nvn-log');
  if (log) log.innerHTML = '';

  document.getElementById('nvn-run-btn')?.classList.add('hidden');
  document.getElementById('nvn-stop-btn')?.classList.remove('hidden');
  document.getElementById('nvn-results').innerHTML = `
    <div class="text-center text-[#4c566a] font-mono text-sm">
      <i class="fa-solid fa-spinner fa-spin text-2xl mb-2 block text-[#88c0d0]"></i>Benchmark running…
    </div>`;

  const params = new URLSearchParams({ model, nodeA: nodeAId, nodeB: nodeBId, type: nvnType, pull: autoPull ? 'true' : 'false' });
  nvnES = new EventSource(`/api/benchmarks/node-vs-node?${params}`);

  nvnES.addEventListener('log', e => {
    try { const d = JSON.parse(e.data); nvnLog(d.node, d.message); } catch (_) {}
  });

  nvnES.addEventListener('result', e => {
    try { renderNvnResults(JSON.parse(e.data)); } catch (_) {}
  });

  nvnES.addEventListener('done', () => {
    nvnES.close(); nvnES = null;
    document.getElementById('nvn-run-btn')?.classList.remove('hidden');
    document.getElementById('nvn-stop-btn')?.classList.add('hidden');
    refreshNvnModels().then(updateNvnAvailability);
    fetchBenchmarks(); // refresh standard leaderboard
    loadNvnLeaderboard(); // refresh win/loss board
  });

  nvnES.onerror = () => {
    nvnLog('', 'Connection error — benchmark may have ended.');
    nvnES?.close(); nvnES = null;
    document.getElementById('nvn-run-btn')?.classList.remove('hidden');
    document.getElementById('nvn-stop-btn')?.classList.add('hidden');
  };
}

function stopNodeVsNode() {
  if (nvnES) { nvnES.close(); nvnES = null; }
  document.getElementById('nvn-run-btn')?.classList.remove('hidden');
  document.getElementById('nvn-stop-btn')?.classList.add('hidden');
  nvnLog('', 'Stopped by user.');
}

function renderNvnResults(data) {
  const el = document.getElementById('nvn-results');
  if (!el) return;

  const a = data.node_a || {};
  const b = data.node_b || {};
  const bType = data.type || 'standard';

  const isEmbed = bType === 'embedding';
  const metricLabel = isEmbed ? 'ch/s' : 'TPS';
  const metricKey   = 'tps'; // server always uses tps field; for embedding it holds cps

  function winner(va, vb, higherIsBetter = true) {
    if (isNaN(va) || isNaN(vb) || va === 0 || vb === 0) return null;
    return higherIsBetter ? (va >= vb ? 'A' : 'B') : (va <= vb ? 'A' : 'B');
  }

  const wTps  = winner(a.tps, b.tps, true);
  const wTtft = winner(a.ttft_ms, b.ttft_ms, false);
  const wLat  = winner(a.avg_latency_ms, b.avg_latency_ms, false);

  function metricRow(label, va, vb, fmt, wNode) {
    const hiA = wNode === 'A' ? 'text-[#a3be8c] font-bold' : 'text-[#d8dee9]';
    const hiB = wNode === 'B' ? 'text-[#a3be8c] font-bold' : 'text-[#d8dee9]';
    return `
      <tr class="border-b border-[#4c566a]/20">
        <td class="py-2 text-left text-[10px] font-mono text-[#4c566a] uppercase pr-4">${label}</td>
        <td class="py-2 text-center font-mono text-xs ${hiA}">${fmt(va)}</td>
        <td class="py-2 text-center font-mono text-xs ${hiB}">${fmt(vb)}</td>
      </tr>`;
  }

  const fmt1 = v => v > 0 ? v.toFixed(1) : '—';
  const fmtMs = v => v > 0 ? `${v.toFixed(0)} ms` : '—';

  const overallWinner = [wTps === 'A', wTtft === 'A', wLat === 'A'].filter(Boolean).length >= 2 ? 'A' :
                        [wTps === 'B', wTtft === 'B', wLat === 'B'].filter(Boolean).length >= 2 ? 'B' : null;

  const winnerBadge = (node) => overallWinner === node
    ? `<span class="ml-1.5 text-[8px] bg-[#a3be8c]/20 text-[#a3be8c] border border-[#a3be8c]/40 font-mono px-1.5 py-0.5 rounded uppercase">winner</span>`
    : '';

  el.innerHTML = `
    <div class="w-full space-y-4">
      <!-- Model / type header -->
      <div class="text-center font-mono text-[10px] text-[#4c566a] uppercase tracking-wider">
        <span class="text-[#88c0d0] font-bold">${escapeHTML(data.model || '')}</span>
        &nbsp;·&nbsp;${escapeHTML(bType)}
      </div>

      <!-- Side-by-side node name headers -->
      <div class="grid grid-cols-3 text-center text-xs font-tech uppercase">
        <div></div>
        <div class="text-[#88c0d0] font-bold truncate px-1">
          ${escapeHTML(a.node_name || 'Node A')}${winnerBadge('A')}
          ${a.has_error ? '<div class="text-[#bf616a] text-[9px] normal-case mt-0.5">error</div>' : ''}
        </div>
        <div class="text-[#a3be8c] font-bold truncate px-1">
          ${escapeHTML(b.node_name || 'Node B')}${winnerBadge('B')}
          ${b.has_error ? '<div class="text-[#bf616a] text-[9px] normal-case mt-0.5">error</div>' : ''}
        </div>
      </div>

      <!-- Metrics table -->
      <table class="w-full">
        <thead>
          <tr class="border-b border-[#4c566a]/40">
            <th class="py-1 text-left text-[9px] font-tech uppercase text-[#4c566a]">Metric</th>
            <th class="py-1 text-center text-[9px] font-tech uppercase text-[#88c0d0]">${escapeHTML(a.node_name || 'A')}</th>
            <th class="py-1 text-center text-[9px] font-tech uppercase text-[#a3be8c]">${escapeHTML(b.node_name || 'B')}</th>
          </tr>
        </thead>
        <tbody>
          ${!isEmbed ? metricRow('TTFT', a.ttft_ms, b.ttft_ms, fmtMs, wTtft) : ''}
          ${metricRow(metricLabel, a.tps, b.tps, fmt1, wTps)}
          ${!isEmbed ? metricRow('Latency', a.avg_latency_ms, b.avg_latency_ms, fmtMs, wLat) : ''}
        </tbody>
      </table>

      <!-- Delta row -->
      ${(wTps && !a.has_error && !b.has_error) ? (() => {
        const faster = wTps === 'A' ? a : b;
        const slower = wTps === 'A' ? b : a;
        const pct = slower.tps > 0 ? ((faster.tps - slower.tps) / slower.tps * 100).toFixed(1) : '?';
        const fasterName = wTps === 'A' ? (a.node_name || 'Node A') : (b.node_name || 'Node B');
        return `<div class="text-center font-mono text-[11px] bg-[#a3be8c]/10 border border-[#a3be8c]/30 rounded-lg p-2 text-[#a3be8c]">
          <i class="fa-solid fa-trophy mr-1 text-[10px]"></i>
          <strong>${escapeHTML(fasterName)}</strong> is ${pct}% faster in ${metricLabel}
        </div>`;
      })() : ''}
    </div>`;
}

// ── NvN Win/Loss Leaderboard ─────────────────────────────────────────────────

let nvnDrawerNodeId   = null; // currently-expanded node in the match drawer
let nvnDrawerNodeName = null;
let nvnDrawerFilter   = null;

async function loadNvnLeaderboard() {
  const body = document.getElementById('nvn-leaderboard-body');
  if (!body) return;
  try {
    const r = await fetch('/api/benchmarks/nvn-leaderboard');
    if (!r.ok) throw new Error('fetch failed');
    const entries = await r.json();
    if (!entries || entries.length === 0) {
      body.innerHTML = '<div class="text-center text-[#4c566a] font-mono text-xs py-4 italic">No matches recorded yet — run a comparison to start tracking wins.</div>';
      return;
    }
    // Sort: wins desc, then matches desc
    entries.sort((a, b) => b.wins - a.wins || b.matches - a.matches);
    const maxWins = Math.max(...entries.map(e => e.wins), 1);

    body.innerHTML = `
      <div class="overflow-x-auto">
        <table class="w-full font-mono text-xs">
          <thead>
            <tr class="border-b border-[#4c566a]/40 text-[9px] font-tech uppercase text-[#4c566a]">
              <th class="py-1.5 text-left pl-1">Node</th>
              <th class="py-1.5 text-center w-10">Rank</th>
              <th class="py-1.5 text-center w-28">Win Rate</th>
              <th class="py-1.5 text-center w-16 text-[#a3be8c]">Wins</th>
              <th class="py-1.5 text-center w-16 text-[#bf616a]">Losses</th>
              <th class="py-1.5 text-center w-12">Ties</th>
              <th class="py-1.5 text-center w-16">Matches</th>
            </tr>
          </thead>
          <tbody>
            ${entries.map((e, i) => {
              const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
              const winPct = e.win_rate.toFixed(0);
              const safeId   = escapeHTML(e.node_id);
              const safeName = escapeHTML(e.node_name);
              return `
              <tr class="border-b border-[#4c566a]/15 hover:bg-[#2e3440]/40 transition-colors">
                <td class="py-2 pl-1">
                  <button onclick="openNvnDrawer('${safeId}','${safeName}','all')"
                          class="font-bold text-[#88c0d0] hover:text-[#d8dee9] hover:underline text-left font-mono text-xs max-w-[140px] truncate block"
                          title="View all matches for ${safeName}">${safeName}</button>
                </td>
                <td class="py-2 text-center text-[11px]">${rank}</td>
                <td class="py-2 px-2">
                  <div class="flex items-center gap-1.5">
                    <div class="flex-1 h-1.5 bg-[#2e3440] rounded-full overflow-hidden">
                      <div class="h-full rounded-full ${winPct >= 50 ? 'bg-[#a3be8c]' : 'bg-[#bf616a]'}" style="width:${winPct}%"></div>
                    </div>
                    <span class="text-[10px] w-7 text-right ${winPct >= 50 ? 'text-[#a3be8c]' : 'text-[#bf616a]'}">${winPct}%</span>
                  </div>
                </td>
                <td class="py-2 text-center">
                  <button onclick="openNvnDrawer('${safeId}','${safeName}','win')"
                          class="font-bold text-[#a3be8c] hover:underline font-mono text-xs"
                          title="View wins">${e.wins}</button>
                </td>
                <td class="py-2 text-center">
                  <button onclick="openNvnDrawer('${safeId}','${safeName}','loss')"
                          class="font-bold text-[#bf616a] hover:underline font-mono text-xs"
                          title="View losses">${e.losses}</button>
                </td>
                <td class="py-2 text-center text-[#4c566a]">${e.ties}</td>
                <td class="py-2 text-center">
                  <button onclick="openNvnDrawer('${safeId}','${safeName}','all')"
                          class="hover:underline font-mono text-xs text-[#4c566a] hover:text-[#d8dee9]"
                          title="View all matches">${e.matches}</button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  } catch {
    body.innerHTML = '<div class="text-center text-[#bf616a] font-mono text-xs py-2">Failed to load leaderboard.</div>';
  }
}

async function openNvnDrawer(nodeId, nodeName, filter) {
  const drawer = document.getElementById('nvn-match-drawer');
  const title  = document.getElementById('nvn-drawer-title');
  const list   = document.getElementById('nvn-match-list');
  if (!drawer || !list) return;

  nvnDrawerNodeId   = nodeId;
  nvnDrawerNodeName = nodeName;
  nvnDrawerFilter   = filter;
  const filterLabel = filter === 'win' ? 'Wins' : filter === 'loss' ? 'Losses' : 'All Matches';
  title.textContent = `${nodeName} — ${filterLabel}`;
  list.innerHTML = '<div class="text-[#4c566a] font-mono text-[10px] italic py-2 text-center">Loading…</div>';
  drawer.classList.remove('hidden');

  try {
    const r = await fetch(`/api/benchmarks/nvn-matches?nodeId=${encodeURIComponent(nodeId)}`);
    const matches = await r.json();

    const filtered = matches.filter(m => {
      if (filter === 'win')  return m.winner_id === nodeId;
      if (filter === 'loss') return m.winner_id !== nodeId && m.winner_id !== '' && !m.node_a_error && !m.node_b_error;
      return true;
    });

    if (filtered.length === 0) {
      list.innerHTML = '<div class="text-[#4c566a] font-mono text-[10px] italic py-2 text-center">No matches in this category.</div>';
      return;
    }

    list.innerHTML = filtered.map(m => {
      // Orient everything relative to the focused node
      const isA      = m.node_a_id === nodeId;
      const myName   = isA ? m.node_a_name  : m.node_b_name;
      const oppName  = isA ? m.node_b_name  : m.node_a_name;
      const myTPS    = isA ? m.node_a_tps   : m.node_b_tps;
      const oppTPS   = isA ? m.node_b_tps   : m.node_a_tps;
      const myTTFT   = isA ? m.node_a_ttft  : m.node_b_ttft;
      const oppTTFT  = isA ? m.node_b_ttft  : m.node_a_ttft;
      const myLat    = isA ? m.node_a_lat   : m.node_b_lat;
      const oppLat   = isA ? m.node_b_lat   : m.node_a_lat;
      const myErr    = isA ? m.node_a_error : m.node_b_error;
      const oppErr   = isA ? m.node_b_error : m.node_a_error;

      const won = m.winner_id === nodeId;
      const tie = m.winner_id === '';

      const outcomeCls = myErr  ? 'border-[#4c566a]/60 bg-[#2e3440]/30'
                       : won   ? 'border-[#a3be8c]/40 bg-[#a3be8c]/5'
                       : tie   ? 'border-[#ebcb8b]/30 bg-[#ebcb8b]/5'
                               : 'border-[#bf616a]/30 bg-[#bf616a]/5';

      const outcomeBadge = myErr ? `<span class="px-1.5 py-0.5 rounded text-[9px] font-tech bg-[#4c566a]/30 text-[#4c566a]">ERROR</span>`
                         : won  ? `<span class="px-1.5 py-0.5 rounded text-[9px] font-tech bg-[#a3be8c]/20 text-[#a3be8c] border border-[#a3be8c]/40">WIN</span>`
                         : tie  ? `<span class="px-1.5 py-0.5 rounded text-[9px] font-tech bg-[#ebcb8b]/15 text-[#ebcb8b] border border-[#ebcb8b]/30">TIE</span>`
                                : `<span class="px-1.5 py-0.5 rounded text-[9px] font-tech bg-[#bf616a]/15 text-[#bf616a] border border-[#bf616a]/30">LOSS</span>`;

      const modelShort = m.model_name.split('/').pop(); // strip hf.co/org/ prefix
      const date = m.created_at ? m.created_at.substring(0, 16).replace('T', ' ') : '';

      // Per-metric winner highlighting (lower latency/ttft is better, higher tps is better)
      const hiTPS  = v => myTPS > 0 && oppTPS > 0 ? (v === myTPS && myTPS >= oppTPS ? 'text-[#a3be8c] font-bold' : v === myTPS ? '' : myTPS >= oppTPS ? '' : 'text-[#a3be8c] font-bold') : '';
      const hiLow  = (vMy, vOpp) => vMy > 0 && vOpp > 0 ? (vMy <= vOpp ? 'text-[#a3be8c] font-bold' : '') : '';
      const hiHigh = (vMy, vOpp) => vMy > 0 && vOpp > 0 ? (vMy >= vOpp ? 'text-[#a3be8c] font-bold' : '') : '';

      const fmt1  = v => v > 0 ? v.toFixed(1) : '—';
      const fmtMs = v => v > 0 ? `${Math.round(v)} ms` : '—';

      return `
        <div class="rounded-lg border ${outcomeCls} p-3 font-mono text-[10px] space-y-2">
          <!-- Match header -->
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <div class="flex items-center gap-2 flex-wrap">
              ${outcomeBadge}
              <span class="text-[#4c566a] uppercase text-[9px] font-tech">${escapeHTML(m.bench_type)}</span>
              <span class="text-[#d8dee9]">vs <strong class="text-[#88c0d0]">${escapeHTML(oppName)}</strong></span>
            </div>
            <div class="flex items-center gap-2 text-[9px] text-[#4c566a]">
              <span class="truncate max-w-[120px]" title="${escapeHTML(m.model_name)}">${escapeHTML(modelShort)}</span>
              <span>${date}</span>
              <button onclick="deleteNvnMatch(${m.id})"
                      class="text-[#4c566a] hover:text-[#bf616a] transition-colors p-0.5 rounded"
                      title="Delete this result">
                <i class="fa-solid fa-trash text-[9px]"></i>
              </button>
            </div>
          </div>
          <!-- Side-by-side metrics -->
          <div class="grid grid-cols-4 gap-1 text-[9px]">
            <div class="text-[#4c566a] font-tech uppercase"></div>
            <div class="text-center font-tech text-[#88c0d0] truncate">${escapeHTML(myName)}</div>
            <div class="text-center font-tech text-[#a3be8c] truncate">${escapeHTML(oppName)}</div>
            <div class="text-[#4c566a]"></div>

            <div class="text-[#4c566a] uppercase">TPS</div>
            <div class="text-center ${hiHigh(myTPS, oppTPS)}">${fmt1(myTPS)}</div>
            <div class="text-center ${hiHigh(oppTPS, myTPS)}">${fmt1(oppTPS)}</div>
            <div class="text-[#4c566a]">tok/s</div>

            ${myTTFT > 0 || oppTTFT > 0 ? `
            <div class="text-[#4c566a] uppercase">TTFT</div>
            <div class="text-center ${hiLow(myTTFT, oppTTFT)}">${fmtMs(myTTFT)}</div>
            <div class="text-center ${hiLow(oppTTFT, myTTFT)}">${fmtMs(oppTTFT)}</div>
            <div class="text-[#4c566a]">↓ better</div>` : ''}

            ${myLat > 0 || oppLat > 0 ? `
            <div class="text-[#4c566a] uppercase">Latency</div>
            <div class="text-center ${hiLow(myLat, oppLat)}">${fmtMs(myLat)}</div>
            <div class="text-center ${hiLow(oppLat, myLat)}">${fmtMs(oppLat)}</div>
            <div class="text-[#4c566a]">↓ better</div>` : ''}
          </div>
        </div>`;
    }).join('');
  } catch {
    list.innerHTML = '<div class="text-[#bf616a] font-mono text-[10px] text-center py-2">Failed to load matches.</div>';
  }
}

function closeNvnDrawer() {
  nvnDrawerNodeId   = null;
  nvnDrawerNodeName = null;
  nvnDrawerFilter   = null;
  const drawer = document.getElementById('nvn-match-drawer');
  if (drawer) drawer.classList.add('hidden');
}

async function deleteNvnMatch(id) {
  try {
    const r = await fetch(`/api/benchmarks/nvn-matches/${id}`, { method: 'DELETE' });
    if (!r.ok) { showToast('Failed to delete match', 'error'); return; }
    showToast('Match deleted', 'success');
    // Refresh the drawer in place and update the leaderboard
    if (nvnDrawerNodeId) openNvnDrawer(nvnDrawerNodeId, nvnDrawerNodeName, nvnDrawerFilter);
    loadNvnLeaderboard();
  } catch {
    showToast('Failed to delete match', 'error');
  }
}

let optimizerEventSource = null;

function startOptimizerBenchmark() {
  const modelSelect = document.getElementById('optimizer-model-select');
  if (!modelSelect) return;
  
  const model = modelSelect.value;
  if (!model) {
    showToast('Please select a model to evaluate', 'warning');
    return;
  }
  
  const promptInput = document.getElementById('optimizer-prompt-input');
  const prompt = promptInput ? promptInput.value.trim() : '';
  
  const runBtn = document.getElementById('run-optimizer-btn');
  const cancelBtn = document.getElementById('cancel-optimizer-btn');
  const logContainer = document.getElementById('optimizer-log');
  
  // Reset UI elements
  for (let i = 1; i <= 3; i++) {
    document.getElementById(`opt-ttft-${i}`).textContent = '--';
    document.getElementById(`opt-tps-${i}`).textContent = '--';
    document.getElementById(`opt-lat-${i}`).textContent = '--';
    const badge = document.getElementById(`opt-badge-${i}`);
    if (badge) {
      badge.classList.add('hidden');
      badge.textContent = '';
    }
  }
  
  if (runBtn) runBtn.disabled = true;
  if (cancelBtn) {
    cancelBtn.classList.remove('hidden');
    cancelBtn.disabled = false;
  }
  if (logContainer) {
    logContainer.innerHTML = `<div class="text-[#88c0d0] uppercase animate-pulse">Initializing parameter sweep suite for ${model}...</div>`;
  }
  
  if (optimizerEventSource) {
    optimizerEventSource.close();
  }
  
  let url = `/api/optimizer/run?model=${encodeURIComponent(model)}`;
  if (prompt) {
    url += `&prompt=${encodeURIComponent(prompt)}`;
  }
  
  optimizerEventSource = new EventSource(url);
  
  const results = {};
  
  optimizerEventSource.addEventListener('status', (e) => {
    if (logContainer) {
      const div = document.createElement('div');
      div.className = 'py-0.5 border-b border-[#4c566a]/10 last:border-none';
      div.textContent = e.data;
      logContainer.appendChild(div);
      logContainer.scrollTop = logContainer.scrollHeight;
    }
  });
  
  optimizerEventSource.addEventListener('error', (e) => {
    if (logContainer) {
      const div = document.createElement('div');
      div.className = 'text-[#bf616a] font-bold mt-1';
      div.textContent = `[ERROR] ${e.data || 'Sweep failed or was cancelled.'}`;
      logContainer.appendChild(div);
      logContainer.scrollTop = logContainer.scrollHeight;
    }
    optimizerEventSource.close();
    if (runBtn) runBtn.disabled = false;
    if (cancelBtn) cancelBtn.classList.add('hidden');
    recordStreamFailure('optimizer', e.data || 'Sweep failed or was cancelled.', { model, node: activeServerLabel() });
    showToast('Optimization sweep failed', 'error');
  });
  
  optimizerEventSource.addEventListener('config_result', (e) => {
    try {
      const res = JSON.parse(e.data);
      let idx = 1;
      if (res.temperature === 0.7) idx = 2;
      if (res.temperature === 1.2) idx = 3;
      
      results[idx] = res;
      
      document.getElementById(`opt-ttft-${idx}`).textContent = `${res.ttft_ms.toFixed(1)} ms`;
      document.getElementById(`opt-tps-${idx}`).textContent = `${res.tps.toFixed(1)}`;
      document.getElementById(`opt-lat-${idx}`).textContent = `${res.avg_latency.toFixed(0)} ms`;
      
      if (logContainer) {
        const div = document.createElement('div');
        div.className = 'text-[#ebcb8b] py-0.5 font-bold';
        div.textContent = `[RESULT] ${res.config_name}: TPS = ${res.tps.toFixed(1)}, TTFT = ${res.ttft_ms.toFixed(1)}ms`;
        logContainer.appendChild(div);
        logContainer.scrollTop = logContainer.scrollHeight;
      }
    } catch (err) {
      console.error('Error parsing config result', err);
    }
  });
  
  optimizerEventSource.addEventListener('done', (e) => {
    if (logContainer) {
      const div = document.createElement('div');
      div.className = 'text-[#a3be8c] font-bold mt-2 border-t border-[#a3be8c]/20 pt-1';
      div.textContent = `[COMPLETED] Sweep complete.`;
      logContainer.appendChild(div);
      logContainer.scrollTop = logContainer.scrollHeight;
    }
    
    // Highlight the best configurations
    highlightBestConfigs(results);
    
    showToast('Optimization sweep completed successfully!', 'success');
    optimizerEventSource.close();
    if (runBtn) runBtn.disabled = false;
    if (cancelBtn) cancelBtn.classList.add('hidden');
    loadOptimizerHistory();
  });
  
  optimizerEventSource.onerror = (err) => {
    console.warn('Optimizer EventSource error:', err);
    optimizerEventSource.close();
    if (runBtn) runBtn.disabled = false;
    if (cancelBtn) cancelBtn.classList.add('hidden');
    recordStreamFailure('optimizer', 'Connection to optimizer stream was interrupted.', { model, node: activeServerLabel() });
  };
}

function cancelOptimizerBenchmark() {
  if (!optimizerEventSource) return;
  optimizerEventSource.close();
  optimizerEventSource = null;
  const runBtn = document.getElementById('run-optimizer-btn');
  const cancelBtn = document.getElementById('cancel-optimizer-btn');
  const logContainer = document.getElementById('optimizer-log');
  if (runBtn) runBtn.disabled = false;
  if (cancelBtn) cancelBtn.classList.add('hidden');
  if (logContainer) {
    const div = document.createElement('div');
    div.className = 'text-[#ebcb8b] font-bold mt-1';
    div.textContent = '[CANCELLED] Optimizer stream stopped by user.';
    logContainer.appendChild(div);
    logContainer.scrollTop = logContainer.scrollHeight;
  }
  showToast('Optimizer sweep stopped', 'warning');
}

function highlightBestConfigs(results) {
  let bestTpsIdx = null;
  let maxTps = -1;
  let bestTtftIdx = null;
  let minTtft = Infinity;
  
  for (let idx in results) {
    const res = results[idx];
    if (res.tps > maxTps) {
      maxTps = res.tps;
      bestTpsIdx = idx;
    }
    if (res.ttft_ms < minTtft) {
      minTtft = res.ttft_ms;
      bestTtftIdx = idx;
    }
  }
  
  if (bestTpsIdx) {
    const badge = document.getElementById(`opt-badge-${bestTpsIdx}`);
    if (badge) {
      badge.className = 'absolute top-2 right-2 text-[9px] font-bold px-1.5 py-0.5 rounded bg-[#a3be8c]/35 text-[#a3be8c] border border-[#a3be8c]/50';
      badge.textContent = '⚡ FASTEST';
      badge.classList.remove('hidden');
    }
  }
  
  if (bestTtftIdx) {
    const badge = document.getElementById(`opt-badge-${bestTtftIdx}`);
    if (badge) {
      if (bestTtftIdx === bestTpsIdx) {
        badge.textContent = '⚡ BEST ALL-AROUND';
        badge.className = 'absolute top-2 right-2 text-[9px] font-bold px-1.5 py-0.5 rounded bg-[#88c0d0]/35 text-[#88c0d0] border border-[#88c0d0]/50';
      } else {
        badge.className = 'absolute top-2 right-2 text-[9px] font-bold px-1.5 py-0.5 rounded bg-[#88c0d0]/35 text-[#88c0d0] border border-[#88c0d0]/50';
        badge.textContent = '⏱️ LOWEST TTFT';
      }
      badge.classList.remove('hidden');
    }
  }
}

async function loadOptimizerHistory() {
  // Grouping (by server+model+params, last-3 per group) is done server-side.
  const container = document.getElementById('optimizer-history-container');
  if (!container) return;

  try {
    const response = await fetch('/api/optimizer/runs/grouped');
    if (!response.ok) throw new Error('Failed to fetch parameter optimizer history');
    const groups = await response.json();

    if (!groups || groups.length === 0) {
      container.innerHTML = `
        <div class="text-center py-12 text-[#4c566a] italic text-xs">
          No past runs logged for the parameter optimizer yet. Run a suite on the left to start history logging.
        </div>
      `;
      return;
    }

    let html = '';
    groups.forEach(g => {
      html += `
        <div class="tech-panel border border-[#4c566a]/40 rounded-lg p-3 bg-[#2e3440]/30 space-y-2">
          <div class="flex justify-between items-center pb-1.5 border-b border-[#4c566a]/30">
            <div>
              <span class="text-[10px] font-bold text-[#88c0d0] uppercase tracking-wide">${escapeHTML(g.model_name)}</span>
              <span class="text-[9px] text-[#4c566a] ml-1.5 font-mono">on ${escapeHTML(g.server_name || g.server_url)}</span>
            </div>
            <span class="badge badge-outline border-[#4c566a] text-[#ebcb8b] text-[9px] font-mono px-2 py-0.5">
              Temp: ${g.temperature} / P: ${g.top_p} / K: ${g.top_k}
            </span>
          </div>
          <div class="overflow-x-auto">
            <table class="table table-compact w-full text-[10px] font-mono text-[#d8dee9] bg-transparent">
              <thead>
                <tr class="text-[#4c566a] border-b border-[#4c566a]/20">
                  <th class="bg-transparent text-left py-1 font-tech uppercase text-[8px]">Date & Time</th>
                  <th class="bg-transparent text-center py-1 font-tech uppercase text-[8px]">TTFT</th>
                  <th class="bg-transparent text-center py-1 font-tech uppercase text-[8px]">TPS</th>
                  <th class="bg-transparent text-center py-1 font-tech uppercase text-[8px]">Avg Latency</th>
                  <th class="bg-transparent text-left py-1 font-tech uppercase text-[8px] max-w-[150px] truncate">Response Preview</th>
                  <th class="bg-transparent text-right py-1 font-tech uppercase text-[8px]">Action</th>
                </tr>
              </thead>
              <tbody>
      `;

      (g.runs || []).forEach(r => {
        html += `
          <tr class="hover:bg-[#3b4252]/10 border-b border-[#4c566a]/10 last:border-none transition-colors">
            <td class="py-1.5 text-left text-[#4c566a]">${escapeHTML(r.created_at)}</td>
            <td class="py-1.5 text-center">${r.ttft_ms.toFixed(1)} ms</td>
            <td class="py-1.5 text-center font-bold text-[#a3be8c]">${r.tps.toFixed(1)}</td>
            <td class="py-1.5 text-center">${r.avg_latency_ms.toFixed(0)} ms</td>
            <td class="py-1.5 text-left max-w-[150px] truncate text-[#d8dee9]/80 italic" title="${escapeHTML(r.response_preview)}">
              "${escapeHTML(r.response_preview)}"
            </td>
            <td class="py-1.5 text-right">
              <button onclick="deleteOptimizerRun(${r.id})" class="btn btn-ghost btn-xs text-[#bf616a] hover:bg-[#bf616a]/15 p-1 h-auto min-h-0">
                <i class="fa-solid fa-trash-can text-[9px]"></i>
              </button>
            </td>
          </tr>
        `;
      });

      html += `
              </tbody>
            </table>
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
  } catch (error) {
    container.innerHTML = `
      <div class="text-center py-8 text-[#bf616a] italic text-xs">
        Failed to load optimization history: ${error.message}
      </div>
    `;
  }
}

async function deleteOptimizerRun(id) {
  if (!confirm('Are you sure you want to delete this optimizer run record?')) return;
  
  try {
    const response = await fetch(`/api/optimizer/runs/${id}`, {
      method: 'DELETE'
    });
    
    if (!response.ok) throw new Error('Failed to delete run record');
    
    showToast('Optimizer run record deleted', 'warning');
    loadOptimizerHistory();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// --- DOCUMENT RAG CONTROLLER ---

// Configure PDF.js worker — vendored locally so airgapped / firewall installs work
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/js/pdf.worker.min.js';
}

async function handleRAGUpload(file) {
  const modelSelect = document.getElementById('rag-model-select');
  if (!modelSelect || !modelSelect.value) {
    showToast('Please select an embedding model first.', 'warning');
    return;
  }
  const model = modelSelect.value;

  const progressDiv     = document.getElementById('rag-upload-progress');
  const progressStatus  = document.getElementById('rag-progress-status');
  const progressPercent = document.getElementById('rag-progress-percent');
  const progressBar     = document.getElementById('rag-progress-bar');
  const uploadLogs      = document.getElementById('rag-upload-logs');

  if (progressDiv) progressDiv.classList.remove('hidden');
  if (uploadLogs) uploadLogs.innerHTML = '';

  const logMessage = (msg, isError = false) => {
    const time  = new Date().toLocaleTimeString();
    const style = isError ? 'text-[#bf616a]' : 'text-[#d8dee9]/80';
    if (uploadLogs) {
      uploadLogs.innerHTML += `<div class="${style}">[${time}] ${msg}</div>`;
      uploadLogs.scrollTop = uploadLogs.scrollHeight;
    }
  };

  const updateProgress = (pct, status) => {
    if (progressPercent) progressPercent.textContent = `${pct}%`;
    if (progressBar) progressBar.style.width = `${pct}%`;
    if (progressStatus) progressStatus.textContent = status;
  };

  // All extraction, chunking, embedding, and saving now happens server-side.
  // The browser just uploads the file and reads a streaming NDJSON response —
  // no text data ever touches the JS main thread, eliminating OOM crashes.

  const MAX_FILE_MB = 50;
  const fileMB = file.size / (1024 * 1024);
  if (fileMB > MAX_FILE_MB) {
    showToast(`File too large (${fileMB.toFixed(1)} MB). Maximum is ${MAX_FILE_MB} MB.`, 'error');
    if (progressDiv) progressDiv.classList.add('hidden');
    return;
  }

  updateProgress(3, 'Uploading...');
  logMessage(`Uploading ${file.name} (${fileMB.toFixed(1)} MB) for server-side processing...`);
  if (fileMB > 20) {
    logMessage(`⚠ Large file — extraction and embedding may take a moment.`);
  }

  try {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('embedding_model', model);

    const response = await fetch('/api/rag/upload-and-index', {
      method: 'POST',
      body: formData  // browser sets multipart boundary automatically
    });

    // Pre-stream errors (400, 422, 503, etc.) arrive as plain JSON
    if (!response.ok) {
      let errMsg = `Server error ${response.status}`;
      try { const e = await response.json(); errMsg = e.error || errMsg; } catch (_) {}
      throw new Error(errMsg);
    }

    // Stream the NDJSON response — each line is a JSON event
    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = '';
    let success   = false;

    streamLoop:
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep any incomplete trailing line for the next chunk

      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch (_) { continue; }

        switch (event.type) {
          case 'progress':
            updateProgress(event.pct ?? 0, event.message ?? '');
            logMessage(event.message ?? '');
            break;

          case 'done':
            updateProgress(100, 'Indexing complete!');
            logMessage(`All ${event.chunks} chunk${event.chunks !== 1 ? 's' : ''} indexed (document ID: ${event.document_id}).`);
            showToast(`Successfully indexed "${file.name}" — ${event.chunks} chunks.`, 'success');
            success = true;
            break streamLoop;

          case 'error':
            throw new Error(event.message || 'Unknown server error');
        }
      }
    }

    if (success) {
      loadRAGDocuments();
      const fileInput = document.getElementById('rag-file-input');
      if (fileInput) fileInput.value = '';
    } else if (!success) {
      // Stream ended without a done event (server closed connection early)
      throw new Error('Upload stream ended unexpectedly — check server logs.');
    }

  } catch (error) {
    console.error('RAG Upload Error:', error);
    logMessage(`ERROR: ${error.message}`, true);
    updateProgress(0, 'Indexing failed.');
    showToast(error.message, 'error');
  }
}

async function loadRAGDocuments() {
  const tbody = document.getElementById('rag-documents-list');
  const emptyMessage = document.getElementById('rag-empty-message');
  if (!tbody) return;
  
  try {
    const response = await fetch('/api/rag/documents');
    if (!response.ok) throw new Error('Failed to load documents');
    
    const docs = await response.json();
    
    if (!docs || docs.length === 0) {
      tbody.innerHTML = '';
      if (emptyMessage) emptyMessage.classList.remove('hidden');
      return;
    }
    
    if (emptyMessage) emptyMessage.classList.add('hidden');
    
    let html = '';
    docs.forEach(doc => {
      const createdDate = new Date(doc.created_at).toLocaleString();
      // Escape probe phrase for use in onclick attribute (single-quoted JS string)
      const probeEscaped = (doc.probe_phrase || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ').trim();
      const modelEscaped = (doc.embedding_model || '').replace(/'/g, "\\'");
      const hasProbe = probeEscaped.length > 0;
      html += `
        <tr class="hover:bg-[#3b4252]/20 border-b border-[#4c566a]/20 last:border-none transition-colors">
          <td class="py-2.5 pl-0 font-bold text-[#d8dee9] max-w-[180px] truncate" title="${escapeHTML(doc.name)}">
            <i class="fa-regular fa-file-code text-[#88c0d0] mr-1.5"></i>${escapeHTML(doc.name)}
          </td>
          <td class="py-2.5 text-[#4c566a] text-xs font-mono select-all">${escapeHTML(doc.embedding_model)}</td>
          <td class="py-2.5 text-center text-[#88c0d0] font-bold">${doc.chunk_count || 0}</td>
          <td class="py-2.5 text-[#4c566a] text-[10px]">${createdDate}</td>
          <td class="py-2.5 text-center pr-0">
            <div class="flex items-center justify-center gap-1">
              ${hasProbe ? `
              <button onclick="testRAGDocument('${probeEscaped}', '${modelEscaped}')"
                      title="Auto-test: runs a similarity search using an excerpt from this document to verify retrieval works"
                      class="btn btn-ghost btn-xs text-[#a3be8c] hover:bg-[#a3be8c]/15 p-1 h-auto min-h-0 font-tech text-[9px]">
                <i class="fa-solid fa-flask text-[10px]"></i> TEST
              </button>` : ''}
              <button onclick="deleteRAGDocument(${doc.id}, '${escapeHTML(doc.name)}')" class="btn btn-ghost btn-xs text-[#bf616a] hover:bg-[#bf616a]/15 p-1 h-auto min-h-0">
                <i class="fa-solid fa-trash-can text-[10px]"></i>
              </button>
            </div>
          </td>
        </tr>
      `;
    });
    tbody.innerHTML = html;
  } catch (error) {
    console.error('Error loading RAG documents:', error);
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="text-center py-6 text-[#bf616a] italic text-xs">
          Failed to load indexed documents: ${error.message}
        </td>
      </tr>
    `;
  }
}

async function deleteRAGDocument(id, name) {
  if (!confirm(`Are you sure you want to delete and un-index document "${name}"? This cannot be undone.`)) {
    return;
  }
  
  try {
    const response = await fetch(`/api/rag/documents/${id}`, {
      method: 'DELETE'
    });
    
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to delete document');
    }
    
    showToast(`Successfully deleted document "${name}"`, 'warning');
    loadRAGDocuments();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// Pre-fills the similarity tester with a known phrase from the document and fires the query.
// The probe phrase is the first ~200 chars of chunk 0, fetched from the server alongside the document list.
function testRAGDocument(probePhrase, embeddingModel) {
  const queryInput  = document.getElementById('rag-test-query');
  const modelSelect = document.getElementById('rag-model-select');
  if (!queryInput || !modelSelect) return;

  // Set the embedding model to match the document's model
  if (embeddingModel && modelSelect.querySelector(`option[value="${CSS.escape(embeddingModel)}"]`)) {
    modelSelect.value = embeddingModel;
  }

  // Fill the query with the probe phrase
  queryInput.value = probePhrase;

  // Scroll the similarity tester panel into view and highlight the input briefly
  queryInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
  queryInput.classList.add('border-[#a3be8c]');
  setTimeout(() => queryInput.classList.remove('border-[#a3be8c]'), 1500);

  // Run the query
  runRAGSimilarityQuery();
}

async function runRAGSimilarityQuery() {
  const queryInput  = document.getElementById('rag-test-query');
  const resultsDiv  = document.getElementById('rag-query-results');
  const modelSelect = document.getElementById('rag-model-select');
  
  if (!queryInput || !resultsDiv || !modelSelect) return;
  
  const query = queryInput.value.trim();
  if (!query) {
    showToast('Please enter a test query first.', 'warning');
    return;
  }
  
  if (!modelSelect.value) {
    showToast('Please select an embedding model first.', 'warning');
    return;
  }
  
  resultsDiv.innerHTML = `
    <div class="flex items-center justify-center gap-2 py-8 text-xs text-[#88c0d0]">
      <i class="fa-solid fa-circle-notch animate-spin text-sm"></i>
      <span>Performing cosine similarity check...</span>
    </div>
  `;
  
  try {
    const response = await fetch('/api/rag/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: query,
        embedding_model: modelSelect.value,
        top_k: 3
      })
    });
    
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to query similarity');
    }
    
    const results = await response.json();
    
    if (!results || results.length === 0) {
      resultsDiv.innerHTML = `
        <div class="text-[#4c566a] italic text-xs text-center py-8">
          No matching chunks found in database for the selected model. Index documents under this model first.
        </div>
      `;
      return;
    }
    
    let html = '';
    results.forEach((res) => {
      const scorePercent = (res.similarity * 100).toFixed(1);
      html += `
        <div class="border border-[#4c566a]/30 rounded-lg p-3 bg-[#2e3440]/40 font-mono text-[11px] leading-relaxed transition-all hover:border-[#88c0d0]/50">
          <div class="flex items-center justify-between mb-2 text-[9px] text-[#88c0d0] border-b border-[#4c566a]/15 pb-1">
            <span class="truncate max-w-[70%] font-bold"><i class="fa-regular fa-file-code"></i> ${escapeHTML(res.document_name)} (Chunk #${res.chunk_index})</span>
            <span class="bg-[#a3be8c]/15 text-[#a3be8c] border border-[#a3be8c]/35 rounded px-1.5 py-0.5 font-bold">${scorePercent}% Match</span>
          </div>
          <div class="text-[#d8dee9] select-text whitespace-pre-wrap">${escapeHTML(res.content)}</div>
        </div>
      `;
    });
    resultsDiv.innerHTML = html;
  } catch (error) {
    console.error('Similarity search error:', error);
    resultsDiv.innerHTML = `
      <div class="text-center py-8 text-[#bf616a] italic text-xs border border-[#bf616a]/35 bg-[#bf616a]/5 rounded-lg">
        Failed to query similarity: ${error.message}
      </div>
    `;
    showToast(error.message, 'error');
  }
}
