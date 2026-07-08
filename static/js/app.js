// State Management
let servers = [];
let expectedAgentVersion = null;
let models = [];
let modelCtxLengths   = {}; // model_name → trained context length (int)
let modelCapabilities = {}; // model_name → string[] from /api/show e.g. ["completion","tools","vision","thinking"]
let modelBenchSummary = {}; // model_name → { std_grade, std_tps, code_grade, code_quality, hallu_recall, hallu_ctx_k }
let dashRagDocCount = null;
let _notesSaveTimer = null;
let modelJsonCaps     = {}; // model_name → 'pass'|'fail'|'pending'|undefined (localStorage-cached JSON probe results)
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

// Inventory sort state
let inventorySortCol = 'name';
let inventorySortDir = 'asc';

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
      const ctxLabel  = fmtCtx(modelCtxLengths[opt.value]);

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

      if (ctxLabel) {
        const ctxSpan = document.createElement('span');
        ctxSpan.className = 'ss-opt-param';
        ctxSpan.style.color = '#8fbcbb';
        ctxSpan.style.borderColor = 'rgba(143,188,187,0.3)';
        ctxSpan.textContent = ctxLabel;
        li.appendChild(ctxSpan);
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
    const paramMatch = fullText.match(/^(.+?)\s*\((.+?)\)$/);
    const dispText  = paramMatch ? paramMatch[1] : fullText;
    const paramHint = paramMatch && paramMatch[2] !== '?' ? paramMatch[2] : '';
    const ctxLabel  = opt ? fmtCtx(modelCtxLengths[opt.value]) : '';

    // Build trigger content: name (truncates) + param badge + ctx badge
    // triggerText uses flex so long names truncate with ellipsis and badges stay visible.
    triggerText.style.display = 'flex';
    triggerText.style.alignItems = 'center';
    triggerText.style.gap = '4px';
    triggerText.style.minWidth = '0';
    triggerText.innerHTML = '';
    const nameNode = document.createElement('span');
    nameNode.className = 'ss-opt-name'; // flex:1, min-width:0, overflow:hidden, text-overflow:ellipsis
    nameNode.textContent = dispText;
    triggerText.appendChild(nameNode);
    if (paramHint) {
      const pb = document.createElement('span');
      pb.className = 'ss-opt-param';
      pb.textContent = paramHint;
      triggerText.appendChild(pb);
    }
    if (ctxLabel) {
      const cb = document.createElement('span');
      cb.className = 'ss-opt-param';
      cb.style.color = '#8fbcbb';
      cb.style.borderColor = 'rgba(143,188,187,0.3)';
      cb.textContent = ctxLabel;
      triggerText.appendChild(cb);
    }
    trigger.title = fullText + (ctxLabel ? ` — ${ctxLabel}` : '');
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

  const widget = { open, close, refresh() { updateTrigger(); if (isOpen) renderOptions(searchInput.value); } };
  selectEl._ssWidget = widget; // allow external callers to refresh after data changes
  return widget;
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

// ── Theme Management ──────────────────────────────────────────────────────────
// Maps user preference string → DaisyUI data-theme value.
// "dark"   → "nord"  (fully styled, default)
// "light"  → "light" (DaisyUI light; hardcoded panel colors won't change — beta)
// "system" → auto-detect prefers-color-scheme

function resolveThemePref(pref) {
  if (pref === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'nord';
  }
  return pref === 'light' ? 'light' : 'nord';
}

// applyTheme is called from radio onchange handlers and on init.
function applyTheme(pref) {
  document.documentElement.setAttribute('data-theme', resolveThemePref(pref));
  localStorage.setItem('neurollama_theme', pref);
  // Keep radio buttons in sync (in case called programmatically)
  const radio = document.querySelector(`input[name="theme-select"][value="${pref}"]`);
  if (radio) radio.checked = true;
}

function initTheme() {
  // Prefer DB-persisted value (loaded by loadPreferences), fall back to localStorage
  const pref = getPref('theme', localStorage.getItem('neurollama_theme') || 'dark');
  applyTheme(pref);
  // Re-apply on system preference change when "system" is selected
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (getPref('theme', 'dark') === 'system') applyTheme('system');
  });
}

function togglePreferences() {
  const panel   = document.getElementById('preferences-panel');
  const chevron = document.getElementById('pref-chevron');
  if (!panel) return;
  const isOpen = !panel.classList.contains('hidden');
  if (isOpen) {
    closePreferences();
  } else {
    panel.classList.remove('hidden');
    if (chevron) chevron.style.transform = 'rotate(180deg)';
  }
}

function closePreferences() {
  const panel   = document.getElementById('preferences-panel');
  const chevron = document.getElementById('pref-chevron');
  if (panel)   panel.classList.add('hidden');
  if (chevron) chevron.style.transform = 'rotate(0deg)';
}
// ── End Theme Management ─────────────────────────────────────────────────────

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
  // Close preferences panel when clicking outside of it or its trigger button
  document.addEventListener('click', e => {
    const panel = document.getElementById('preferences-panel');
    const btn   = document.getElementById('user-badge-btn');
    if (!panel || panel.classList.contains('hidden')) return;
    if (!panel.contains(e.target) && !btn?.contains(e.target)) closePreferences();
  });
});

// ── Tooltip engine ───────────────────────────────────────────────────────────
// Lightweight cursor-following tooltip. Add data-tip="..." to any element.
// Supports \n for line breaks. Positioned below+right of cursor, clamped to viewport.

function initTooltip() {
  const tip = document.createElement('div');
  tip.id = 'app-tooltip';
  tip.style.cssText = 'position:fixed;z-index:9999;pointer-events:none;display:none;' +
    'padding:4px 8px;border-radius:4px;' +
    'background:#1e2430;border:1px solid rgba(76,86,106,0.7);' +
    'color:#d8dee9;font-size:10px;font-family:ui-monospace,monospace;' +
    'line-height:1.4;max-width:260px;white-space:pre-wrap;word-break:break-word;' +
    'box-shadow:0 4px 12px rgba(0,0,0,0.4);';
  document.body.appendChild(tip);

  let showTimer = null;
  let currentTarget = null;

  function place(x, y) {
    const ox = 14, oy = 18;
    tip.style.left = '0px'; tip.style.top = '0px'; tip.style.display = 'block';
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.display = 'none';
    const cx = Math.min(x + ox, window.innerWidth  - tw - 8);
    const cy = Math.min(y + oy, window.innerHeight - th - 8);
    tip.style.left = cx + 'px';
    tip.style.top  = cy + 'px';
  }

  document.addEventListener('mouseover', e => {
    const target = e.target.closest('[data-tip]');
    if (!target || target === currentTarget) return;
    clearTimeout(showTimer);
    currentTarget = target;
    showTimer = setTimeout(() => {
      tip.textContent = target.dataset.tip;
      place(e.clientX, e.clientY);
      tip.style.display = 'block';
    }, 130);
  });

  document.addEventListener('mousemove', e => {
    if (tip.style.display !== 'none') {
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      const cx = Math.min(e.clientX + 14, window.innerWidth  - tw - 8);
      const cy = Math.min(e.clientY + 18, window.innerHeight - th - 8);
      tip.style.left = cx + 'px';
      tip.style.top  = cy + 'px';
    }
  });

  document.addEventListener('mouseout', e => {
    const target = e.target.closest('[data-tip]');
    if (target && !target.contains(e.relatedTarget)) {
      clearTimeout(showTimer);
      tip.style.display = 'none';
      currentTarget = null;
    }
  });
}

// ── Modelfile Fix Wizard ──────────────────────────────────────────────────────

let _mfwOriginalName = '';
let _mfwCreatedName  = '';
let _mfwAbortCtrl    = null;

function openModelFixWizard(name) {
  _mfwOriginalName = name;
  _mfwCreatedName  = '';
  const modal = document.getElementById('modelfix-modal');
  if (!modal) return;

  document.getElementById('modelfix-title-name').textContent = name;
  _mfwShowStep('loading');
  modal.showModal();

  fetch(`/api/models/detail?name=${encodeURIComponent(name)}`)
    .then(r => r.ok ? r.json() : Promise.reject(new Error('Failed to load model details')))
    .then(details => {
      const sys = details.system || '';
      document.getElementById('modelfix-system-input').value = sys;
      document.getElementById('modelfix-system-label').textContent =
        sys ? `(${sys.length} chars — currently set)` : '(none — may be in TEMPLATE or model weights)';

      // Default new name: strip existing -clean suffix if re-running, then append -clean
      const base = name.replace(/-clean$/, '');
      document.getElementById('modelfix-name-input').value = base + '-clean';

      modelFixUpdatePreview();
      _mfwShowStep('configure');
    })
    .catch(e => { showToast(e.message, 'error'); closeModelFixWizard(); });
}

function _mfwShowStep(step) {
  ['loading', 'configure', 'creating', 'done'].forEach(s => {
    const el = document.getElementById(`modelfix-step-${s}`);
    if (el) el.classList.toggle('hidden', s !== step);
  });
}

function modelFixClearSystem() {
  document.getElementById('modelfix-system-input').value = '';
  document.getElementById('modelfix-system-label').textContent = '(will be cleared)';
  modelFixUpdatePreview();
}

function modelFixUpdatePreview() {
  const nameEl    = document.getElementById('modelfix-name-input');
  const sysEl     = document.getElementById('modelfix-system-input');
  const previewEl = document.getElementById('modelfix-preview');
  const warnEl    = document.getElementById('modelfix-overwrite-warn');
  if (!nameEl || !sysEl || !previewEl) return;

  const newName = nameEl.value.trim();
  const sysText = sysEl.value;

  if (warnEl) warnEl.classList.toggle('hidden', newName !== _mfwOriginalName);

  let mf = `FROM ${_mfwOriginalName}\n`;
  if (sysText) {
    mf += (sysText.includes('\n') || sysText.includes('"'))
      ? `SYSTEM """\n${sysText}\n"""\n`
      : `SYSTEM "${sysText}"\n`;
  } else {
    mf += `SYSTEM ""\n`;
  }
  previewEl.textContent = mf;
}

function _mfwBuildModelfile() {
  const sysText = document.getElementById('modelfix-system-input').value;
  let mf = `FROM ${_mfwOriginalName}\n`;
  if (sysText) {
    mf += (sysText.includes('\n') || sysText.includes('"'))
      ? `SYSTEM """\n${sysText}\n"""\n`
      : `SYSTEM "${sysText}"\n`;
  } else {
    mf += `SYSTEM ""\n`;
  }
  return mf;
}

async function confirmModelFix() {
  const newName = document.getElementById('modelfix-name-input')?.value.trim();
  if (!newName) { showToast('Enter a model name', 'error'); return; }

  const modelfile = _mfwBuildModelfile();
  _mfwCreatedName = newName;

  _mfwShowStep('creating');
  const logBox   = document.getElementById('modelfix-create-log');
  const closeBtn = document.getElementById('modelfix-close-creating-btn');
  const nameSpan = document.getElementById('modelfix-creating-name');
  logBox.innerHTML = '';
  if (nameSpan) nameSpan.textContent = ` "${newName}"`;
  if (closeBtn) closeBtn.disabled = true;

  try {
    _mfwAbortCtrl = new AbortController();
    const response = await fetch('/api/models/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName, modelfile }),
      signal: _mfwAbortCtrl.signal,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || 'Create request failed');
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let succeeded = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim() || !line.startsWith('data:')) continue;
        try {
          const chunk = JSON.parse(line.substring(5).trim());
          if (chunk.status) {
            const s = chunk.status.toUpperCase();
            const cls = (s.includes('SUCCESS') || s.includes('COMPLETE'))
              ? 'text-[#a3be8c] font-bold'
              : (s.includes('ERR') || s.includes('FAIL'))
              ? 'text-[#bf616a] font-bold'
              : 'text-[#d8dee9]';
            logBox.insertAdjacentHTML('beforeend', `<div class="${cls}">>> ${s}</div>`);
            logBox.scrollTop = logBox.scrollHeight;
            if (s.includes('SUCCESS')) succeeded = true;
          }
        } catch {}
      }
    }

    if (closeBtn) closeBtn.disabled = false;
    const doneMsg = document.getElementById('modelfix-done-msg');
    const chatBtn = document.getElementById('modelfix-chat-btn');
    if (doneMsg) doneMsg.innerHTML = succeeded
      ? `<span class="text-[#a3be8c]"><i class="fa-solid fa-circle-check mr-2"></i>Model <strong class="font-mono">${escapeHTML(newName)}</strong> created successfully.</span>`
      : `<span class="text-[#88c0d0]"><i class="fa-solid fa-circle-info mr-2"></i>Model <strong class="font-mono">${escapeHTML(newName)}</strong> created.</span>`;
    if (chatBtn) chatBtn.classList.remove('hidden');
    _mfwShowStep('done');
    showToast(`Model '${newName}' created`, 'success');
    fetchModels();
    populateModelDropdowns();

  } catch (e) {
    if (e.name === 'AbortError') return;
    if (closeBtn) closeBtn.disabled = false;
    const doneMsg = document.getElementById('modelfix-done-msg');
    if (doneMsg) doneMsg.innerHTML = `<span class="text-[#bf616a]"><i class="fa-solid fa-circle-exclamation mr-2"></i>${escapeHTML(e.message)}</span>`;
    _mfwShowStep('done');
  }
}

function modelFixOpenInChat() {
  if (!_mfwCreatedName) return;
  closeModelFixWizard();
  switchWorkspace('chat');
  setTimeout(() => {
    const sel = document.getElementById('chat-model-select');
    if (sel) {
      sel.value = _mfwCreatedName;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      if (sel._ssWidget) sel._ssWidget.refresh();
    }
  }, 350);
}

function closeModelFixWizard() {
  const modal = document.getElementById('modelfix-modal');
  if (modal) modal.close();
  if (_mfwAbortCtrl) { _mfwAbortCtrl.abort(); _mfwAbortCtrl = null; }
  setTimeout(() => _mfwShowStep('loading'), 200); // reset after close animation
}

async function init() {
  // Load all user preferences from DB before restoring any state.
  await loadPreferences();
  // Apply theme from DB pref (may override the localStorage early-apply)
  initTheme();
  // Restore cached JSON capability probe results
  try {
    const raw = localStorage.getItem('neurollama-json-caps');
    if (raw) modelJsonCaps = JSON.parse(raw);
  } catch (_) {}

  initTooltip();
  initAccordionRow();
  // Non-blocking: fire and forget — page renders immediately, server cards and
  // status dots fill in once the (now-instant) cache read completes.
  fetchServers();
  fetch('/healthz').then(r => r.json()).then(d => { if (d.agent_version) expectedAgentVersion = d.agent_version; }).catch(() => {});
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

  // Context-size warning listeners — fire on model or ctx select change
  ['chat-model-select', 'chat-ctx-limit'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () =>
      updateCtxWarning('chat-model-select', 'chat-ctx-limit', 'chat-ctx-warn'));
  });
  ['code-bench-model', 'code-bench-ctx'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () =>
      updateCtxWarning('code-bench-model', 'code-bench-ctx', 'code-ctx-warn'));
  });
  ['halluc-model', 'halluc-max-context'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', updateHalluCtxWarning);
  });
  ['completion-model-select', 'completion-ctx-limit'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () =>
      updateCtxWarning('completion-model-select', 'completion-ctx-limit', 'completion-ctx-warn'));
  });
  ['builder-base-select', 'builder-ctx-select'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () =>
      updateCtxWarning('builder-base-select', 'builder-ctx-select', 'builder-ctx-warn'));
  });

  // Initialize RAG chat sidebar controls
  const chatRagEnabledEl = document.getElementById('chat-rag-enabled');
  const chatRagModelContainer = document.getElementById('chat-rag-model-container');
  const chatRagTopKContainer = document.getElementById('chat-rag-top-k-container');
  const chatRagCollectionContainer = document.getElementById('chat-rag-collection-container');

  function updateChatRAGControlsState() {
    if (!chatRagEnabledEl) return;
    const enabled = chatRagEnabledEl.checked;

    setPref('chat-rag-enabled', enabled);

    // Toggle each RAG control container consistently
    [
      { el: chatRagModelContainer,      selector: 'select' },
      { el: chatRagTopKContainer,       selector: 'input'  },
      { el: chatRagCollectionContainer, selector: 'select' },
    ].forEach(({ el, selector }) => {
      if (!el) return;
      if (enabled) {
        el.classList.remove('opacity-50', 'pointer-events-none');
        const ctrl = el.querySelector(selector);
        if (ctrl) ctrl.disabled = false;
      } else {
        el.classList.add('opacity-50', 'pointer-events-none');
        const ctrl = el.querySelector(selector);
        if (ctrl) ctrl.disabled = true;
      }
    });
  }

  if (chatRagEnabledEl) {
    chatRagEnabledEl.addEventListener('change', () => {
      updateChatRAGControlsState();
      if (chatRagEnabledEl.checked) fetchRAGCollections();
    });
    
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
    'code-bench-model',
    'code-judge-model-select',
    'code-bench-ctx',
    'code-lang-filter',
    'halluc-model',
    'halluc-max-context',
  ].forEach(id => {
    const el = document.getElementById(id);
    if (el) makeSearchableSelect(el);
  });

  initCodeBenchLangGrid();
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
  const tabs = ['home', 'inventory', 'playground', 'completion', 'builder', 'benchmark', 'rag', 'system', 'fleet'];
  tabs.forEach(t => {
    const btn = document.getElementById(`ws-tab-${t}`);
    const panel = document.getElementById(`ws-panel-${t}`);
    if (btn) btn.classList.toggle('tab-active', t === workspace);
    if (panel) panel.classList.toggle('hidden', t !== workspace);
  });

  activeWorkspace = workspace;
  setPref('active-workspace', workspace);

  // Tab specific actions
  if (workspace === 'home') {
    renderDashboard();
    if (dashRagDocCount === null) fetchDashRagCount();
    if (_activityAllEntries.length === 0) fetchDashActivity();
    if (Object.keys(modelBenchSummary).length === 0) fetchModelBenchSummary();
  } else if (workspace === 'inventory') {
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
    fetchRAGCollections();
  } else if (workspace === 'fleet') {
    fetchFleetOverview();
    fetchSSHKeys();
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
    markActivitySeen();
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
    // Build release type badge (used in About and footer)
    const rtBadge = (() => {
      if (!d.releaseType || d.releaseType === 'stable') return '';
      const [cls, label] = d.releaseType === 'pre-release'
        ? ['bg-[#ebcb8b]/15 text-[#ebcb8b] border-[#ebcb8b]/40', 'PRE-RELEASE']
        : ['bg-[#4c566a]/30 text-[#4c566a] border-[#4c566a]/40', 'DEV'];
      return `<span class="ml-1.5 px-1.5 py-0.5 rounded border font-mono text-[9px] uppercase tracking-wider ${cls}">${label}</span>`;
    })();

    // Update footer version badge
    const footerVer = document.getElementById('footer-version');
    if (footerVer) {
      footerVer.innerHTML = `<span class="font-mono text-[#d8dee9]/50">${escapeHTML(d.version)}</span>${rtBadge}`;
      footerVer.classList.remove('hidden');
      footerVer.classList.add('flex');
    }

    grid.innerHTML =
      row('Version',        d.version + rtBadge) +
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
    grid.innerHTML = `<div class="col-span-full text-[#bf616a] font-mono text-xs">Failed to load app info: ${escapeHTML(e.message)}</div>`;
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

async function wipeAllLocalStorage() {
  if (!await showConfirm('Clear ALL NEUROLLAMA local data from this browser? This cannot be undone.', 'Wipe Local Data')) return;
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
  if (!await showConfirm('Delete ALL chat history? This cannot be undone.', 'Delete All Chats')) return;
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
  if (!await showConfirm('Delete ALL benchmark results? This cannot be undone.', 'Delete All Benchmarks')) return;
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
  if (!await showConfirm(`Restore from "${file.name}"?\n\nThe application must be restarted to apply the restore. Current data will be replaced.`)) return;

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
  rag:       { bg: 'bg-[#8fbcbb]/15', text: 'text-[#8fbcbb]',  label: 'RAG'       },
  optimizer: { bg: 'bg-[#d08770]/15', text: 'text-[#d08770]',  label: 'OPT'       },
  system:    { bg: 'bg-[#4c566a]/30', text: 'text-[#d8dee9]',   label: 'SYSTEM'    },
};

let _activityFilter    = 'all';
let _activityLastCount = 0;  // count seen when activity panel was last opened

let _activityAllEntries = []; // full list, filtered on render

function startActivityPoll() {
  fetchActivity();
  const liveEl = document.getElementById('activity-live-dot');
  if (liveEl) liveEl.classList.remove('hidden');
  if (!activityPollInterval) {
    activityPollInterval = setInterval(fetchActivity, 5000);
  }
}

function stopActivityPoll() {
  if (activityPollInterval) {
    clearInterval(activityPollInterval);
    activityPollInterval = null;
  }
  const liveEl = document.getElementById('activity-live-dot');
  if (liveEl) liveEl.classList.add('hidden');
}

async function fetchActivity() {
  try {
    const res = await fetch('/api/activity');
    if (!res.ok) return;
    const entries = await res.json();
    _activityAllEntries = entries;
    renderActivityLog(entries);
    // Update tab badge if activity panel is not currently open
    const panel = document.getElementById('ws-panel-activity');
    const panelVisible = panel && !panel.classList.contains('hidden');
    const badge = document.getElementById('activity-new-badge');
    if (badge) {
      if (!panelVisible && entries.length > _activityLastCount) {
        const diff = entries.length - _activityLastCount;
        badge.textContent = diff > 99 ? '99+' : String(diff);
        badge.classList.remove('hidden');
      } else if (panelVisible) {
        _activityLastCount = entries.length;
        badge.classList.add('hidden');
      }
    }
  } catch { /* silent — poll will retry */ }
}

function markActivitySeen() {
  _activityLastCount = _activityAllEntries.length;
  const badge = document.getElementById('activity-new-badge');
  if (badge) badge.classList.add('hidden');
}

function setActivityFilter(cat) {
  _activityFilter = cat;
  // Update pill styles
  document.querySelectorAll('.activity-filter-btn').forEach(btn => {
    const isCat = btn.id === `af-${cat}`;
    btn.classList.toggle('active', isCat);
    if (isCat) {
      btn.classList.add('border-[#88c0d0]/50', 'text-[#88c0d0]', 'bg-[#88c0d0]/10');
      btn.classList.remove('border-[#4c566a]/50', 'text-[#4c566a]');
    } else {
      btn.classList.remove('border-[#88c0d0]/50', 'text-[#88c0d0]', 'bg-[#88c0d0]/10');
      btn.classList.add('border-[#4c566a]/50', 'text-[#4c566a]');
    }
  });
  renderActivityLog(_activityAllEntries);
}

function renderActivityLog(entries) {
  const list = document.getElementById('activity-log-list');
  const countEl = document.getElementById('activity-count');
  if (!list) return;

  const filtered = _activityFilter === 'all'
    ? entries
    : entries.filter(e => e.category === _activityFilter);

  if (countEl) countEl.textContent = filtered.length ? `(${filtered.length})` : '';

  if (!filtered.length) {
    const msg = _activityFilter === 'all'
      ? 'No activity yet. Events will appear here as you use the app.'
      : `No ${_activityFilter} events recorded yet.`;
    list.innerHTML = `<div class="px-4 py-6 text-center text-[#4c566a] text-[11px]">${msg}</div>`;
    return;
  }

  list.innerHTML = filtered.map(e => {
    const style = ACTIVITY_CATEGORY_STYLE[e.category] || ACTIVITY_CATEGORY_STYLE.system;
    return `
      <div class="flex items-start gap-3 px-4 py-2.5 hover:bg-[#2e3440]/40 transition-colors">
        <span class="font-mono text-[10px] text-[#4c566a] shrink-0 pt-px w-24">${escapeHTML(e.time)}</span>
        <span class="shrink-0 inline-block px-1.5 py-0.5 rounded text-[9px] font-mono font-bold tracking-wider ${style.bg} ${style.text}">${style.label}</span>
        <span class="font-mono text-[11px] text-[#d8dee9] leading-relaxed">${escapeHTML(e.message)}</span>
      </div>`;
  }).join('');
}

function exportActivityLog() {
  const entries = _activityFilter === 'all'
    ? _activityAllEntries
    : _activityAllEntries.filter(e => e.category === _activityFilter);
  if (!entries.length) { showToast('No entries to export', 'warning'); return; }
  const text = entries.map(e => `[${e.time}] [${e.category.toUpperCase()}] ${e.message}`).join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href: url,
    download: `neurollama-activity-${new Date().toISOString().slice(0, 10)}.txt`,
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function clearActivityDisplay() {
  _activityAllEntries = [];
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

async function branchFromMessage(index) {
  if (!activeChatId) return;
  if (isGeneratingChat) {
    abortChatGeneration();
    await new Promise(r => setTimeout(r, 150));
  }
  const trimmedMsg = chatMessages[index];
  try {
    const res = await fetch(`/api/chats/${activeChatId}/trim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keep_count: index })
    });
    if (!res.ok) throw new Error('Trim failed');
    chatMessages = chatMessages.slice(0, index);
    renderChatHistory();
    if (trimmedMsg && trimmedMsg.role === 'user') {
      const input = document.getElementById('chat-input-text');
      if (input) {
        input.value = trimmedMsg.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        input.focus();
        input.dispatchEvent(new Event('input'));
      }
    }
    showToast('Branched — conversation rewound.', 'success');
  } catch {
    showToast('Branch failed.', 'error');
  }
}

function populateModelDropdowns() {
  const chatSelect = document.getElementById('chat-model-select');
  const builderSelect = document.getElementById('builder-base-select');
  const completionSelect = document.getElementById('completion-model-select');
  const benchmarkSelect = document.getElementById('benchmark-model-select');
  const optimizerSelect = document.getElementById('optimizer-model-select');
  const ragSelect = document.getElementById('rag-model-select');
  const chatRagSelect = document.getElementById('chat-rag-model-select');
  const codeBenchModel = document.getElementById('code-bench-model');
  const codeJudgeModel = document.getElementById('code-judge-model-select');
  const hallucModel = document.getElementById('halluc-model');

  // All-model option string (chat, completion, builder, benchmark, etc.)
  const options = models.map(m => {
    const paramSize = (m.details && m.details.parameter_size) || '?';
    return `<option value="${m.name}">${m.name} (${paramSize})</option>`;
  }).join('');

  // Embedding-only option string for RAG selects.
  // Falls back to all models (with a separator) if no embedding models are detected,
  // so installs without explicit embedding models still work.
  const embedModels = models.filter(m => getModelCapabilities(m).includes('embedding'));
  const otherModels = models.filter(m => !getModelCapabilities(m).includes('embedding'));
  const ragOptions = embedModels.length > 0
    ? [
        embedModels.length > 0
          ? `<optgroup label="── Embedding models ──">${embedModels.map(m => `<option value="${m.name}">${m.name}</option>`).join('')}</optgroup>`
          : '',
        otherModels.length > 0
          ? `<optgroup label="── Other models ──">${otherModels.map(m => `<option value="${m.name}">${m.name}</option>`).join('')}</optgroup>`
          : '',
      ].join('')
    : options; // no embedding models detected — show all

  if (models.length === 0) {
    const noModels = '<option value="">-- No models available --</option>';
    if (chatSelect) chatSelect.innerHTML = noModels;
    if (builderSelect) builderSelect.innerHTML = noModels;
    if (completionSelect) completionSelect.innerHTML = noModels;
    if (benchmarkSelect) benchmarkSelect.innerHTML = noModels;
    if (optimizerSelect) optimizerSelect.innerHTML = noModels;
    if (ragSelect) ragSelect.innerHTML = noModels;
    if (chatRagSelect) chatRagSelect.innerHTML = noModels;
    if (codeBenchModel) codeBenchModel.innerHTML = noModels;
    if (codeJudgeModel) codeJudgeModel.innerHTML = noModels;
    if (hallucModel) hallucModel.innerHTML = noModels;
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
      ragSelect.innerHTML = ragOptions;
      if (currentSelected && ragSelect.querySelector(`option[value="${CSS.escape(currentSelected)}"]`)) {
        ragSelect.value = currentSelected;
      }
    }
    if (chatRagSelect) {
      const currentSelected = chatRagSelect.value || getPref('chat-rag-model-select') || '';
      chatRagSelect.innerHTML = ragOptions;
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
    if (codeBenchModel) {
      const cur = codeBenchModel.value;
      codeBenchModel.innerHTML = options;
      if (cur && codeBenchModel.querySelector(`option[value="${CSS.escape(cur)}"]`)) codeBenchModel.value = cur;
    }
    if (codeJudgeModel) {
      const cur = codeJudgeModel.value;
      codeJudgeModel.innerHTML = options;
      if (cur && codeJudgeModel.querySelector(`option[value="${CSS.escape(cur)}"]`)) codeJudgeModel.value = cur;
    }
    if (hallucModel) {
      const cur = hallucModel.value;
      hallucModel.innerHTML = options;
      if (cur && hallucModel.querySelector(`option[value="${CSS.escape(cur)}"]`)) hallucModel.value = cur;
    }
  }
  // Keep wizard selects in sync whenever the model list changes
  populateWizardSelects();
  // Re-check name collision now that model list is updated
  builderValidateName();
}

// --- TOAST SYSTEM ---
function showConfirm(message, title = 'Confirm') {
  return new Promise(resolve => {
    const modal  = document.getElementById('confirm-modal');
    const titleEl = document.getElementById('confirm-modal-title');
    const msgEl  = document.getElementById('confirm-modal-message');
    const okBtn  = document.getElementById('confirm-modal-ok');
    const cancelBtn = document.getElementById('confirm-modal-cancel');
    if (!modal) { resolve(window.confirm(message)); return; }
    titleEl.textContent = title;
    msgEl.textContent   = message;
    const done = (result) => {
      modal.close();
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('close', onClose);
      resolve(result);
    };
    const onOk     = () => done(true);
    const onCancel = () => done(false);
    const onClose  = () => done(false);
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('close', onClose, { once: true });
    modal.showModal();
  });
}

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
    populateOllamaUpdateNodeSelect();
    populateAgentDeployNodeSelect();

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
          <div class="flex items-center gap-2 cursor-pointer flex-1" onclick="selectServer('${escapeHTML(srv.id)}')">
            ${statusDot}
            <div>
              <h3 class="font-bold text-xs truncate max-w-[130px] text-[#e5e9f0] group-hover:text-[#88c0d0] transition-colors flex items-center">
                ${escapeHTML(srv.name)}${authLock}
              </h3>
              <p class="text-[9px] font-mono text-[#4c566a] truncate max-w-[130px]" title="${escapeHTML(srv.url)}">${escapeHTML(srv.url)}</p>
            </div>
          </div>
          <div class="flex items-center gap-1 opacity-40 group-hover:opacity-100 transition-opacity">
            <button onclick="openEditServerModal('${escapeHTML(srv.id)}')" class="btn btn-ghost btn-xs p-1 text-[#88c0d0]" title="Edit Node">
              <i class="fa-solid fa-pen"></i>
            </button>
            <button onclick="deleteServer('${escapeHTML(srv.id)}')" class="btn btn-ghost btn-xs p-1 text-[#bf616a]" title="Delete Node">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </div>
        </div>
        <div class="flex items-center justify-between text-[9px] font-mono text-[#4c566a]">
          <span>${isOnline ? `Version: ${escapeHTML(srv.version || '?')}` : 'UNREACHABLE'}</span>
          <div class="flex items-center gap-1">
            <span>${isOnline ? `${escapeHTML(String(srv.latency ?? '—'))} ms` : ''}</span>
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
  dot.dataset.tip = title;
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
  const btn     = document.getElementById('footer-node-btn');
  if (!panel) return;
  const isOpen = !panel.classList.contains('hidden');
  if (isOpen) {
    closeNodeSlideout();
  } else {
    renderNodeSlideout();
    // Position the popover just above the trigger button
    if (btn) {
      const rect = btn.getBoundingClientRect();
      panel.style.left   = rect.left + 'px';
      panel.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
      panel.style.top    = '';
    }
    panel.classList.remove('hidden');
    if (chevron) chevron.style.transform = 'rotate(180deg)'; // up→down when open
  }
}

function closeNodeSlideout() {
  const panel   = document.getElementById('node-slideout');
  const chevron = document.getElementById('footer-node-chevron');
  if (panel)   panel.classList.add('hidden');
  if (chevron) chevron.style.transform = 'rotate(0deg)'; // restore up arrow
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

    // Re-render node-filtered leaderboards so they reflect the new active node.
    if (lbNodeFilter) {
      fetchBenchmarks();
      renderLangLeaderboard();
      renderCodeBenchResults();
      renderHallucLeaderboard();
      renderHallucinationHistory();
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
  
  if (!await showConfirm(`Are you sure you want to remove node '${srv.name}'?`)) return;

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
  const vramRaw      = document.getElementById(`${prefix}-server-vram`)?.value;
  const agentPortRaw = document.getElementById(`${prefix}-server-agent-port`)?.value;
  return {
    name:             document.getElementById(`${prefix}-server-name`).value.trim(),
    url:              document.getElementById(`${prefix}-server-url`).value.trim(),
    vramGb:           vramRaw ? parseFloat(vramRaw) : 0,
    authType:         document.getElementById(`${prefix}-server-auth-type`).value,
    authToken:        document.getElementById(`${prefix}-server-auth-token`).value,
    authUsername:     document.getElementById(`${prefix}-server-auth-username`).value,
    authPassword:     document.getElementById(`${prefix}-server-auth-password`).value,
    authHeaderName:   document.getElementById(`${prefix}-server-auth-header-name`).value,
    authHeaderVal:    document.getElementById(`${prefix}-server-auth-header-val`).value,
    agentPort:        agentPortRaw ? parseInt(agentPortRaw, 10) : 0,
    agentKey:         document.getElementById(`${prefix}-server-agent-key`)?.value || '',
    agentFingerprint: document.getElementById(`${prefix}-server-agent-fingerprint`)?.value || '',
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

async function testAgentConnection(prefix) {
  const id = prefix === 'edit' ? document.getElementById('edit-server-id').value : '';
  if (!id) {
    showToast('Save the node first, then test the agent', 'warning');
    return;
  }
  const keyEl = document.getElementById(`${prefix}-server-agent-key`);
  if (keyEl && keyEl.value) {
    showToast('Save changes first so the agent key is stored, then test', 'warning');
    return;
  }
  try {
    showToast('Testing neuro-agent connection...', 'info');
    const resp = await fetch(`/api/nodes/${encodeURIComponent(id)}/agent-test`, { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Agent test failed');
    showToast(`Agent OK — ${data.hostname} (${data.os}/${data.arch}) v${data.agent_version}`, 'success');
  } catch (e) {
    showToast(`Agent test failed: ${e.message}`, 'error');
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

  const agentPortEl = document.getElementById('edit-server-agent-port');
  if (agentPortEl) agentPortEl.value = srv.agentPort > 0 ? srv.agentPort : '';
  const agentKeyEl = document.getElementById('edit-server-agent-key');
  if (agentKeyEl) agentKeyEl.value = '';
  const agentFpEl = document.getElementById('edit-server-agent-fingerprint');
  if (agentFpEl) agentFpEl.value = srv.agentFingerprint || '';

  // Auto-open agent accordion if the node already has an agent configured
  const agentDetails = document.getElementById('edit-agent-details');
  if (agentDetails) agentDetails.open = !!(srv.agentKey || srv.agentFingerprint);

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
      <td colspan="6" class="py-8 text-center text-[#4c566a]">
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
    // If a cross-node search is active, re-run it so the filtered list reflects
    // the new model state (e.g. after a delete). Otherwise show the full list.
    if (crossNodeSearchQuery) {
      runCrossNodeSearch(crossNodeSearchQuery);
    } else {
      renderModels();
    }
    updateInventorySyncBadge();
    // Keep all model dropdowns in sync regardless of which workspace is active.
    populateModelDropdowns();
    // Fetch context lengths, capabilities, and benchmark summaries in background.
    fetchModelCtxLengths();
    fetchModelCapabilities();
    fetchModelBenchSummary();
    if (activeWorkspace === 'home') renderDashboard();
    // Persist for stale-while-revalidate on next page load.
    try {
      localStorage.setItem('neurollama-model-cache', JSON.stringify({ models, ts: Date.now() }));
    } catch { /* storage quota exceeded — skip */ }
  } catch (error) {
    console.error(error);
    renderModelsEmpty(error.message);
  }
}

// Fetch trained context lengths for all models and store in modelCtxLengths.
// Called once after models load; the ss-widget reads from this map at render time.
async function fetchModelCtxLengths() {
  try {
    const res = await fetch('/api/models/ctx-lengths');
    if (!res.ok) return;
    modelCtxLengths = await res.json();
    // Refresh all ss-widgets so ctx badges appear in triggers without needing to reopen.
    document.querySelectorAll('select[id]').forEach(sel => {
      if (sel._ssWidget) sel._ssWidget.refresh();
    });
    // Run an initial ctx warning check now that lengths are known — the change
    // listeners only fire on user interaction, so a previously-saved high ctx
    // would never show the warning without this explicit call.
    updateCtxWarning('chat-model-select',      'chat-ctx-limit',       'chat-ctx-warn');
    updateCtxWarning('code-bench-model',       'code-bench-ctx',       'code-ctx-warn');
    updateCtxWarning('completion-model-select','completion-ctx-limit', 'completion-ctx-warn');
    updateCtxWarning('builder-base-select',    'builder-ctx-select',   'builder-ctx-warn');
    updateHalluCtxWarning();
  } catch { /* silently ignore */ }
}

// Fetch Ollama-reported capabilities for all models and store in modelCapabilities.
// Falls back to heuristic detection in getModelCapabilities() when a model has no entry.
async function fetchModelCapabilities() {
  try {
    const res = await fetch('/api/models/capabilities');
    if (!res.ok) return;
    modelCapabilities = await res.json();
    // Re-render inventory if visible so new TOOLS/THINK badges appear
    const listBody = document.getElementById('models-list-body');
    if (listBody && listBody.children.length > 0) renderModels();
  } catch { /* silently ignore */ }
}

// Fetch benchmark summary for all models and store in modelBenchSummary.
// Called once after models load; inventory rows read from this map at render time.
async function fetchModelBenchSummary() {
  try {
    const res = await fetch('/api/benchmarks/model-summary');
    if (!res.ok) return;
    modelBenchSummary = await res.json();
    const listBody = document.getElementById('models-list-body');
    if (listBody && listBody.children.length > 0) renderModels();
    if (activeWorkspace === 'home') renderDashboard();
  } catch { /* silently ignore */ }
}

async function fetchDashRagCount() {
  try {
    const res = await fetch('/api/rag/documents');
    if (!res.ok) return;
    const docs = await res.json();
    dashRagDocCount = Array.isArray(docs) ? docs.length : 0;
    if (activeWorkspace === 'home') renderDashboard();
  } catch { /* silent */ }
}

async function fetchDashActivity() {
  try {
    const res = await fetch('/api/activity');
    if (!res.ok) return;
    const entries = await res.json();
    _activityAllEntries = entries;
    if (activeWorkspace === 'home') renderDashboard();
  } catch { /* silent */ }
}

function renderDashboard() {
  const panel = document.getElementById('ws-panel-home');
  if (!panel) return;

  // ── Stat chips ───────────────────────────────────────────────────────────────
  const onlineCount = servers.filter(s => s.status === 'online').length;
  const totalCount  = servers.length;

  const elModels    = document.getElementById('dash-stat-models');
  const elModelsSub = document.getElementById('dash-stat-models-sub');
  const elNodes     = document.getElementById('dash-stat-nodes');
  const elNodesSub  = document.getElementById('dash-stat-nodes-sub');
  const elRag       = document.getElementById('dash-stat-rag');
  const elRagSub    = document.getElementById('dash-stat-rag-sub');
  const elBench     = document.getElementById('dash-stat-bench');
  const elBenchSub  = document.getElementById('dash-stat-bench-sub');

  if (elModels) elModels.textContent = models.length || '—';
  if (elModelsSub) elModelsSub.textContent = models.length ? 'on active node' : 'no node selected';

  if (elNodes) {
    elNodes.innerHTML = totalCount
      ? `${onlineCount}<span style="font-size:13px;color:#4c566a"> / ${totalCount}</span>`
      : '—';
  }
  if (elNodesSub) {
    elNodesSub.textContent = totalCount === 0
      ? 'no nodes registered'
      : onlineCount === totalCount
        ? 'all nodes reachable'
        : `${totalCount - onlineCount} unreachable`;
  }

  if (elRag) elRag.textContent = dashRagDocCount !== null ? String(dashRagDocCount) : '—';
  if (elRagSub) {
    const collCount = ragCollections.length;
    elRagSub.textContent = dashRagDocCount !== null
      ? (collCount > 0 ? `${collCount} collection${collCount !== 1 ? 's' : ''}` : 'default collection')
      : 'open RAG to load';
  }

  const benchCount = Object.keys(modelBenchSummary).length;
  if (elBench) elBench.textContent = benchCount || '—';
  if (elBenchSub) {
    const lastBench = _activityAllEntries.find(e => e.category === 'benchmark');
    elBenchSub.textContent = lastBench ? `last run ${lastBench.time}` : (benchCount ? 'models with data' : 'none run yet');
  }

  // ── Node cards ───────────────────────────────────────────────────────────────
  const nodesList = document.getElementById('dash-nodes-list');
  if (nodesList) {
    if (servers.length === 0) {
      nodesList.innerHTML = `<div class="text-[10px] text-[#4c566a] italic px-1">No nodes registered. Add one in SYSTEM → Settings.</div>`;
    } else {
      nodesList.innerHTML = servers.map(srv => {
        const online  = srv.status === 'online';
        const dot     = online ? 'bg-[#a3be8c]' : 'bg-[#bf616a]';
        const latency = online && srv.latency != null ? `${srv.latency} ms` : '';
        const version = online && srv.version ? srv.version : '';
        const seenAgo = serverLastSeen[srv.id] ? timeAgoShort(serverLastSeen[srv.id]) : '';
        return `
          <div class="bg-[#242933]/60 border border-[#4c566a]/30 rounded-lg p-2.5 cursor-pointer hover:border-[#88c0d0]/30 transition-colors" onclick="switchWorkspace('fleet')">
            <div class="flex items-center justify-between mb-1.5">
              <div class="flex items-center gap-1.5">
                <span class="w-2 h-2 rounded-full shrink-0 ${dot}"></span>
                <span class="text-[11px] font-tech font-bold text-[#d8dee9] truncate">${escapeHTML(srv.name)}</span>
                ${srv.isActive ? '<span class="text-[8px] bg-[#88c0d0]/15 text-[#88c0d0] border border-[#88c0d0]/30 rounded px-1 ml-1">ACTIVE</span>' : ''}
              </div>
              <span class="text-[9px] ${online ? 'text-[#a3be8c]' : 'text-[#bf616a]'} font-tech">${online ? 'ONLINE' : 'OFFLINE'}</span>
            </div>
            <div class="flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] text-[#4c566a] font-mono">
              ${latency ? `<span>${latency}</span>` : ''}
              ${version ? `<span>${escapeHTML(version)}</span>` : ''}
              ${!online && seenAgo ? `<span>last seen ${seenAgo}</span>` : ''}
              ${online ? `<span>${models.length && srv.isActive ? models.length + ' models' : ''}</span>` : ''}
            </div>
          </div>`;
      }).join('');
    }
  }

  // ── Recent activity ──────────────────────────────────────────────────────────
  const actList = document.getElementById('dash-activity-list');
  if (actList) {
    const recent = _activityAllEntries.slice(0, 6);
    if (recent.length === 0) {
      actList.innerHTML = `<div class="px-3 py-3 text-[10px] text-[#4c566a] italic">No activity yet.</div>`;
    } else {
      actList.innerHTML = recent.map(e => {
        const style = ACTIVITY_CATEGORY_STYLE[e.category] || ACTIVITY_CATEGORY_STYLE.system;
        return `
          <div class="flex items-start gap-2 px-3 py-2">
            <span class="text-[8px] font-tech font-bold px-1.5 py-0.5 rounded shrink-0 mt-0.5 ${style.bg} ${style.text} border border-current/20">${escapeHTML(style.label)}</span>
            <div class="flex-1 min-w-0">
              <div class="text-[10px] text-[#d8dee9] leading-snug truncate">${escapeHTML(e.message)}</div>
              <div class="text-[9px] text-[#4c566a] mt-0.5">${escapeHTML(e.time)}</div>
            </div>
          </div>`;
      }).join('');
    }
  }

  // ── Top models ───────────────────────────────────────────────────────────────
  const topEl = document.getElementById('dash-top-models');
  if (topEl) {
    const GRADE_ORDER = { S: 0, A: 1, B: 2, C: 3, F: 4 };
    const ranked = Object.entries(modelBenchSummary)
      .map(([name, b]) => {
        const candidates = [
          b.std_grade  ? { letter: b.std_grade[0],  type: 'std'  } : null,
          b.code_grade ? { letter: b.code_grade[0], type: 'code' } : null,
        ].filter(Boolean).sort((a, x) => (GRADE_ORDER[a.letter] ?? 9) - (GRADE_ORDER[x.letter] ?? 9));
        return candidates.length ? { name, letter: candidates[0].letter, type: candidates[0].type } : null;
      })
      .filter(Boolean)
      .sort((a, b) => (GRADE_ORDER[a.letter] ?? 9) - (GRADE_ORDER[b.letter] ?? 9))
      .slice(0, 6);

    if (ranked.length === 0) {
      topEl.innerHTML = `<div class="px-3 py-3 text-[10px] text-[#4c566a] italic">No benchmarks run yet.</div>`;
    } else {
      const gradeColor = { S: '#ebcb8b', A: '#a3be8c', B: '#88c0d0', C: '#d08770', F: '#bf616a' };
      topEl.innerHTML = ranked.map(m => {
        const col = gradeColor[m.letter] || '#4c566a';
        const shortName = m.name.length > 22 ? m.name.slice(0, 21) + '…' : m.name;
        return `
          <div class="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-[#242933]/60 transition-colors" onclick="inspectModel('${escapeHTML(m.name)}'); switchWorkspace('inventory');">
            <span class="text-[11px] font-bold font-tech w-5 text-center shrink-0" style="color:${col}">${m.letter}</span>
            <span class="text-[10px] text-[#d8dee9] flex-1 truncate font-mono">${escapeHTML(shortName)}</span>
            <span class="text-[8px] text-[#4c566a] border border-[#4c566a]/40 rounded px-1 shrink-0">${m.type}</span>
          </div>`;
      }).join('');
    }
  }
}

// Hallucination-specific ctx warning: halluc-max-context values are in K (e.g. 32 = 32768 tokens).
function updateHalluCtxWarning() {
  updateCtxWarning('halluc-model', 'halluc-max-context', 'hallu-ctx-warn', true);
}

// Show/hide a context-size warning when the selected ctx exceeds the model's
// trained context length. warnId element should be a <span> near the ctx select.
// Set ctxInK=true when the ctx select value is in K tokens rather than raw tokens.
function updateCtxWarning(modelId, ctxId, warnId, ctxInK = false) {
  const warnEl = document.getElementById(warnId);
  if (!warnEl) return;
  const model     = document.getElementById(modelId)?.value;
  const ctxRaw    = document.getElementById(ctxId)?.value;
  const ctxVal    = ctxRaw ? (parseInt(ctxRaw, 10) * (ctxInK ? 1024 : 1)) : 0;
  const trained   = model ? (modelCtxLengths[model] || 0) : 0;
  if (!ctxVal || !trained || ctxVal <= trained) {
    warnEl.classList.add('hidden');
    return;
  }
  const warnMsg = `${fmtCtx(ctxVal)} exceeds this model's trained context (${fmtCtx(trained)})\nOllama will silently clamp it`;
  warnEl.title = warnMsg;
  warnEl.dataset.tip = warnMsg;
  warnEl.classList.remove('hidden');
}

// Format a raw context token count into a human-readable badge string.
function fmtCtx(n) {
  if (!n || n <= 0) return '';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + 'M ctx';
  if (n >= 1024)      return Math.round(n / 1024) + 'K ctx';
  return n + ' ctx';
}

// Parse a parameter-size string (e.g. "7.6B", "671M", "1.5T") to a float in billions.
// Returns null if unparseable.
function parseParamB(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^([\d.]+)\s*([KkMmBbTt])$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = m[2].toUpperCase();
  if (u === 'K') return n / 1_000_000;
  if (u === 'M') return n / 1000;
  if (u === 'B') return n;
  if (u === 'T') return n * 1000;
  return null;
}

function setLbParamRange(min, max) {
  lbParamMin = parseFloat(min) || 0;
  lbParamMax = parseFloat(max) || 0;
  fetchBenchmarks();
}

function toggleLbChart() {
  lbChartActive = !lbChartActive;
  const btn   = document.getElementById('lb-chart-toggle');
  const tbl   = document.getElementById('lb-table-wrapper');
  const chart = document.getElementById('lb-chart-container');
  if (btn)   btn.classList.toggle('btn-active', lbChartActive);
  if (tbl)   tbl.classList.toggle('hidden', lbChartActive);
  if (chart) chart.classList.toggle('hidden', !lbChartActive);
  fetchBenchmarks();
}

function renderLbChart(groups) {
  const container = document.getElementById('lb-chart-container');
  if (!container) return;
  if (!groups.length) {
    container.innerHTML = '<p class="text-center text-[#4c566a] py-12 italic text-xs font-mono">No data to chart</p>';
    return;
  }
  const LB_TYPE_COLOR = {
    standard: '#88c0d0', vision: '#b48ead', embedding: '#ebcb8b',
    longctx: '#a3be8c', reasoning: '#d08770',
    tool_use: '#8fbcbb', json_output: '#81a1c1', instruction_follow: '#5e81ac',
  };
  const BAR_W = 28, GAP = 6, PAD_L = 44, PAD_B = 64, PAD_T = 20, CHART_H = 220;
  const n = groups.length;
  const W = PAD_L + n * (BAR_W + GAP) + 16;
  const H = CHART_H + PAD_T + PAD_B;

  const vals = groups.map(g => {
    let ex = {};
    try { ex = JSON.parse(g.summary_run?.extra_json || '{}'); } catch (_) {}
    if (g.benchmark_type === 'reasoning' || g.benchmark_type === 'tool_use' ||
        g.benchmark_type === 'json_output' || g.benchmark_type === 'instruction_follow')
      return ex.accuracy_pct || 0;
    if (g.benchmark_type === 'embedding') return ex.chunks_per_sec || g.summary_run?.tps || 0;
    return g.summary_run?.tps || 0;
  });
  const maxVal = Math.max(...vals, 0.001);

  const bars = groups.map((g, i) => {
    const v    = vals[i];
    const bH   = Math.max(2, Math.round((v / maxVal) * CHART_H));
    const x    = PAD_L + i * (BAR_W + GAP);
    const y    = PAD_T + CHART_H - bH;
    const fill = LB_TYPE_COLOR[g.benchmark_type] || '#4c566a';
    const label = g.model_name.split(':')[0].slice(0, 14);
    const isAcc = ['reasoning','tool_use','json_output','instruction_follow'].includes(g.benchmark_type);
    const valLabel = isAcc ? `${v.toFixed(0)}%` : v.toFixed(1);
    const lx = x + BAR_W / 2, ly = PAD_T + CHART_H + 6;
    return `<rect x="${x}" y="${y}" width="${BAR_W}" height="${bH}" fill="${fill}" rx="2" opacity="0.85">
              <title>${escapeHTML(g.model_name)} (${g.benchmark_type}): ${valLabel}</title>
            </rect>
            <text x="${lx}" y="${ly}" text-anchor="end"
                  transform="rotate(-45 ${lx} ${ly})"
                  fill="#4c566a" font-size="9" font-family="monospace">${escapeHTML(label)}</text>
            ${v > 0 ? `<text x="${x + BAR_W / 2}" y="${y - 3}" text-anchor="middle" fill="${fill}" font-size="8" font-family="monospace">${valLabel}</text>` : ''}`;
  }).join('');

  const ticks = [0, 1, 2, 3, 4].map(i => {
    const tv  = maxVal * i / 4;
    const ty  = PAD_T + CHART_H - Math.round((tv / maxVal) * CHART_H);
    const tl  = tv >= 10 ? tv.toFixed(0) : tv.toFixed(1);
    return `<line x1="${PAD_L - 2}" y1="${ty}" x2="${W - 4}" y2="${ty}" stroke="#3b4252" stroke-width="0.8"/>
            <text x="${PAD_L - 4}" y="${ty + 3}" text-anchor="end" fill="#4c566a" font-size="8" font-family="monospace">${tl}</text>`;
  }).join('');

  container.innerHTML = `<div class="overflow-x-auto pb-1"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${ticks}${bars}</svg></div>`;
}

// ── JSON capability probe ──────────────────────────────────────────────────
async function probeModelJson(modelName) {
  modelJsonCaps[modelName] = 'pending';
  renderModels();
  try {
    const res = await fetch('/api/models/probe-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName }),
    });
    const data = await res.json();
    modelJsonCaps[modelName] = data.pass ? 'pass' : 'fail';
  } catch (_) {
    modelJsonCaps[modelName] = 'fail';
  }
  try { localStorage.setItem('neurollama-json-caps', JSON.stringify(modelJsonCaps)); } catch (_) {}
  renderModels();
}

async function probeAllJson() {
  for (const m of models) {
    if (modelJsonCaps[m.name] === 'pass' || modelJsonCaps[m.name] === 'pending') continue;
    await probeModelJson(m.name);
  }
}

// Grade → colour classes for inventory benchmark badges.
const GRADE_STYLE = {
  S: { border: 'border-[#ebcb8b]/70', text: 'text-[#ebcb8b]' },
  A: { border: 'border-[#a3be8c]/70', text: 'text-[#a3be8c]' },
  B: { border: 'border-[#88c0d0]/70', text: 'text-[#88c0d0]' },
  C: { border: 'border-[#d08770]/70', text: 'text-[#d08770]' },
  D: { border: 'border-[#d08770]/50', text: 'text-[#d08770]/80' },
  F: { border: 'border-[#bf616a]/60', text: 'text-[#bf616a]' },
};

// Standard bench type → short label for the tooltip.
const STD_TYPE_LABEL = {
  standard:  'Standard TPS',
  vision:    'Vision TPS',
  embedding: 'Embedding',
  long_ctx:  'Long-Context',
  reasoning: 'Reasoning',
};

// Build the compact benchmark badge HTML for one inventory row.
function buildBenchBadges(b) {
  const badges = [];

  // Standard benchmark grade
  if (b.std_grade) {
    const s = GRADE_STYLE[b.std_grade] || GRADE_STYLE.F;
    const typeLabel = STD_TYPE_LABEL[b.std_type] || b.std_type || 'Benchmark';
    const tpsStr = b.std_tps > 0 ? `\n${b.std_tps.toFixed(1)} tokens/sec` : '';
    const gradeDesc = { S:'Top tier (≥90%)', A:'Strong (75–89%)', B:'Good (60–74%)', C:'Fair (45–59%)', D:'Weak (30–44%)', F:'Poor (<30%)' };
    badges.push(
      `<span class="inline-flex items-center gap-0.5 border ${s.border} ${s.text} rounded px-1 text-[8px] font-mono font-bold cursor-default" ` +
      `data-tip="Standard benchmark · ${typeLabel}\nGrade ${b.std_grade}: ${gradeDesc[b.std_grade] || ''}${tpsStr}">` +
      `<i class="fa-solid fa-gauge text-[7px]"></i>${b.std_grade}</span>`
    );
  }

  // Code benchmark grade
  if (b.code_grade) {
    const s = GRADE_STYLE[b.code_grade] || GRADE_STYLE.F;
    const qStr = b.code_quality > 0 ? `\n${b.code_quality.toFixed(1)}/10 quality score` : '';
    const gradeDesc = { S:'Top tier (≥90%)', A:'Strong (75–89%)', B:'Good (60–74%)', C:'Fair (45–59%)', D:'Weak (30–44%)', F:'Poor (<30%)' };
    badges.push(
      `<span class="inline-flex items-center gap-0.5 border ${s.border} ${s.text} rounded px-1 text-[8px] font-mono font-bold cursor-default" ` +
      `data-tip="Code benchmark\nGrade ${b.code_grade}: ${gradeDesc[b.code_grade] || ''}${qStr}">` +
      `<i class="fa-solid fa-code text-[7px]"></i>${b.code_grade}</span>`
    );
  }

  // Hallucination recall badge
  if (b.hallu_recall > 0) {
    const pct = Math.round(b.hallu_recall);
    const borderCls = pct >= 80 ? 'border-[#a3be8c]/60' : pct >= 60 ? 'border-[#d08770]/60' : 'border-[#bf616a]/60';
    const textCls   = pct >= 80 ? 'text-[#a3be8c]'      : pct >= 60 ? 'text-[#d08770]'      : 'text-[#bf616a]';
    const ctxStr = b.hallu_ctx_k > 0 ? ` @ ${b.hallu_ctx_k}K ctx` : '';
    const quality = pct >= 80 ? 'Strong factual recall' : pct >= 60 ? 'Moderate factual recall' : 'Hallucination-prone';
    badges.push(
      `<span class="inline-flex items-center gap-0.5 border ${borderCls} ${textCls} rounded px-1 text-[8px] font-mono cursor-default" ` +
      `data-tip="Hallucination benchmark${ctxStr}\n${pct}% recall — ${quality}">` +
      `<i class="fa-solid fa-brain text-[7px]"></i>${pct}%</span>`
    );
  }

  return badges.join('');
}

// Build a tiny SVG bar-chart sparkline for a multi-run benchmark group.
// runs[] is newest-first (as returned by the server); sparkline renders oldest→newest left→right.
// Returns an empty string when there are fewer than 2 runs.
function buildSparkline(runs, bType) {
  if (!runs || runs.length < 2) return '';

  const values = [...runs].reverse().map(r => {
    try {
      if (bType === 'embedding') return JSON.parse(r.extra_json || '{}').chunks_per_sec || 0;
      if (bType === 'reasoning' || bType === 'tool_use' || bType === 'json_output' || bType === 'instruction_follow')
        return JSON.parse(r.extra_json || '{}').accuracy_pct || 0;
      return r.tps || 0;
    } catch { return 0; }
  });

  const max  = Math.max(...values, 0.001);
  const W = 52, H = 14, n = values.length;
  // Pack bars with 1px gap; minimum bar width 2px
  const barW = Math.max(2, Math.floor((W - (n - 1)) / n));
  const step  = n > 1 ? (W - barW) / (n - 1) : 0;

  const bars = values.map((v, i) => {
    const h    = Math.max(2, Math.round((v / max) * H));
    const x    = Math.round(i * step);
    const fill = i === n - 1 ? '#88c0d0' : '#4c566a'; // newest bar highlighted
    return `<rect x="${x}" y="${H - h}" width="${barW}" height="${h}" fill="${fill}" rx="0.5"/>`;
  }).join('');

  const unit = bType === 'embedding' ? 'ch/s'
             : (bType === 'reasoning' || bType === 'tool_use' || bType === 'json_output' || bType === 'instruction_follow') ? '%acc'
             : 'TPS';
  const latest = values[values.length - 1];
  const latestStr = bType === 'reasoning' ? `${latest.toFixed(1)}%` : latest.toFixed(1);
  const tipText = `${n} runs · latest: ${latestStr} ${unit}\nOldest ← → newest`;
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ` +
    `class="inline-block align-middle ml-2 opacity-60 hover:opacity-100 transition-opacity shrink-0 cursor-default" ` +
    `data-tip="${tipText}">${bars}</svg>`;
}

function initAccordionRow() {
  accordionEl = document.createElement('tr');
  accordionEl.id = 'model-detail-accordion';
  accordionEl.style.display = 'none';
  accordionEl.innerHTML = `
    <td colspan="6" class="p-0">
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
          <button onclick="openModelFixWizard(openAccordionModel)" class="btn btn-xs btn-outline border-[#ebcb8b]/50 text-[#ebcb8b] hover:bg-[#ebcb8b]/10 font-tech text-[9px] gap-1 px-2" data-tip="Open Modelfile Fix Wizard\nEdit or clear the SYSTEM prompt">
            <i class="fa-solid fa-wrench text-[8px]"></i>FIX
          </button>
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
          <button id="detail-tab-notes" onclick="switchDetailTab('notes')" class="detail-tab">NOTES</button>
        </div>
        <div class="overflow-auto max-h-72 bg-[#161820] border border-[#4c566a]/60 rounded-lg p-3 text-[11px] font-mono text-[#d8dee9] relative">
          <button id="detail-copy-btn" onclick="copyTabContent()" class="btn btn-xs btn-neutral absolute top-2 right-2 border-[#4c566a] hover:bg-[#4c566a]" title="Copy to clipboard">
            <i class="fa-regular fa-copy"></i>
          </button>
          <div id="tab-content-text" class="whitespace-pre-wrap break-all pr-8 leading-relaxed font-tech">Loading...</div>
          <textarea id="model-notes-area" class="hidden w-full h-56 bg-transparent text-[#d8dee9] text-[11px] font-mono resize-none outline-none leading-relaxed placeholder-[#4c566a]" placeholder="Personal notes about this model (stored in browser)..." oninput="saveModelNote()"></textarea>
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

// ── Inventory sort ────────────────────────────────────────────────────────────

function setInventorySort(col) {
  if (inventorySortCol === col) {
    inventorySortDir = inventorySortDir === 'asc' ? 'desc' : 'asc';
  } else {
    inventorySortCol = col;
    inventorySortDir = 'asc';
  }
  inventoryPage = 1;
  renderModels();
}

function _sortedModels() {
  const col = inventorySortCol;
  const dir = inventorySortDir === 'asc' ? 1 : -1;
  return [...models].sort((a, b) => {
    let av, bv;
    switch (col) {
      case 'size':
        av = a.size || 0; bv = b.size || 0;
        return dir * (av - bv);
      case 'params': {
        av = parseParamBillions((a.details && a.details.parameter_size) || '');
        bv = parseParamBillions((b.details && b.details.parameter_size) || '');
        if (av === null && bv === null) return 0;
        if (av === null) return 1;   // nulls always last
        if (bv === null) return -1;
        return dir * (av - bv);
      }
      case 'modified':
        av = new Date(a.modified_at).getTime() || 0;
        bv = new Date(b.modified_at).getTime() || 0;
        return dir * (av - bv);
      case 'name':
      default:
        av = (a.name || '').toLowerCase();
        bv = (b.name || '').toLowerCase();
        return dir * (av < bv ? -1 : av > bv ? 1 : 0);
    }
  });
}

function _updateInventorySortHeaders() {
  const cols = ['name', 'size', 'params', 'modified'];
  cols.forEach(col => {
    const th = document.getElementById(`inv-th-${col}`);
    if (!th) return;
    const labels = { name: 'Model Name', size: 'Size', params: 'Parameters', modified: 'Modified' };
    const ind = inventorySortCol === col
      ? (inventorySortDir === 'asc' ? ' ↑' : ' ↓')
      : ' <span class="opacity-25">↕</span>';
    th.innerHTML = labels[col] + ind;
  });
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
        <td colspan="6" class="text-center py-8 text-[#4c566a] italic">
          No models found on this server. Pull a model above to begin.
        </td>
      </tr>
    `;
    renderPagination();
    return;
  }

  // Client-side sort + page slice
  _updateInventorySortHeaders();
  const sorted = _sortedModels();
  const totalPages = Math.ceil(sorted.length / inventoryPageSize);
  if (inventoryPage > totalPages) inventoryPage = Math.max(1, totalPages);
  const start = (inventoryPage - 1) * inventoryPageSize;
  const pageModels = sorted.slice(start, start + inventoryPageSize);

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
      caps.includes('vision')    ? '<span class="inline-flex items-center gap-0.5 border border-[#b48ead] text-[#b48ead] rounded px-1 text-[8px] font-mono font-bold cursor-default" data-tip="Vision / multimodal\nCan process images alongside text"><i class="fa-solid fa-eye text-[7px]"></i>VIS</span>' : '',
      caps.includes('embedding') ? '<span class="inline-flex items-center gap-0.5 border border-[#ebcb8b] text-[#ebcb8b] rounded px-1 text-[8px] font-mono font-bold cursor-default" data-tip="Embedding model\nConverts text to vector representations\nNot suited for chat or benchmarks"><i class="fa-solid fa-layer-group text-[7px]"></i>EMB</span>' : '',
      caps.includes('tools')     ? '<span class="inline-flex items-center gap-0.5 border border-[#a3be8c] text-[#a3be8c] rounded px-1 text-[8px] font-mono font-bold cursor-default" data-tip="Tool / function calling\nSupports structured tool use via Ollama API"><i class="fa-solid fa-wrench text-[7px]"></i>TOOLS</span>' : '',
      caps.includes('thinking')  ? '<span class="inline-flex items-center gap-0.5 border border-[#8fbcbb] text-[#8fbcbb] rounded px-1 text-[8px] font-mono font-bold cursor-default" data-tip="Chain-of-thought / reasoning\nThink suppression applied automatically in benchmarks"><i class="fa-solid fa-lightbulb text-[7px]"></i>THINK</span>' : '',
      (() => {
        const jc = modelJsonCaps[model.name];
        if (jc === 'pass')    return '<span class="inline-flex items-center gap-0.5 border border-[#81a1c1] text-[#81a1c1] rounded px-1 text-[8px] font-mono font-bold cursor-default" data-tip="JSON structured output\nProbed via format:json — reliably returns valid JSON"><i class="fa-solid fa-code text-[7px]"></i>JSON</span>';
        if (jc === 'fail')    return '<span class="inline-flex items-center gap-0.5 border border-[#bf616a]/50 text-[#bf616a]/70 rounded px-1 text-[8px] font-mono font-bold cursor-default" data-tip="JSON structured output\nProbe failed — unreliable JSON output"><i class="fa-solid fa-code text-[7px]"></i>JSON✗</span>';
        if (jc === 'pending') return '<span class="inline-flex items-center gap-0.5 border border-[#4c566a] text-[#4c566a] rounded px-1 text-[8px] font-mono animate-pulse cursor-default" data-tip="Probing JSON capability…"><i class="fa-solid fa-code text-[7px]"></i>JSON</span>';
        return `<button onclick="event.stopPropagation(); probeModelJson('${escapeHTML(model.name)}')" class="inline-flex items-center gap-0.5 border border-[#4c566a]/40 text-[#4c566a] rounded px-1 text-[8px] font-mono hover:border-[#81a1c1]/60 hover:text-[#81a1c1] transition-colors" data-tip="Click to probe JSON structured output capability"><i class="fa-solid fa-code text-[7px]"></i>JSON?</button>`;
      })(),
    ].filter(Boolean).join('');

    // Context length badge
    const ctxLabel = fmtCtx(modelCtxLengths[model.name]);
    const ctxRaw = modelCtxLengths[model.name];
    const ctxBadge = ctxLabel
      ? `<span class="inline-flex items-center gap-0.5 border border-[#88c0d0]/40 text-[#88c0d0] rounded px-1 text-[8px] font-mono cursor-default" data-tip="Trained context window\n${ctxRaw ? ctxRaw.toLocaleString() + ' tokens max' : ctxLabel}">${ctxLabel}</span>`
      : '';

    // Benchmark badges from summary
    const bsum = modelBenchSummary[model.name];
    const benchBadgeHtml = bsum ? buildBenchBadges(bsum) : '';

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
          <div class="flex items-center gap-1 flex-wrap mt-0.5">
            ${ctxBadge}
            ${benchBadgeHtml}
          </div>
          <span class="text-[9px] text-[#4c566a] block sm:hidden mt-0.5">${sizeFormatted} // ${paramSize}</span>
          <span class="text-[9px] text-[#4c566a] block">Modified: ${dateFormatted}</span>
        </td>
        <td class="hidden sm:table-cell">${sizeFormatted}</td>
        <td class="hidden md:table-cell">
          <span class="badge badge-outline border-[#4c566a] text-[#81a1c1] text-[9px] font-mono">${paramSize}</span>
        </td>
        <td class="hidden lg:table-cell text-[#4c566a] font-mono text-[10px]">${dateFormatted}</td>
        <td>
          <div class="flex items-center gap-1.5">
            <button onclick="inspectModel('${model.name}')" class="btn btn-xs btn-neutral border-[#4c566a] text-[10px] font-tech w-[62px]" data-tip="${isOpen ? 'Close details panel' : 'Live VRAM telemetry\nmodel info, parameters'}">
              ${isOpen ? 'CLOSE' : 'INSPECT'}
            </button>
            <button onclick="cloneModelPrompt('${model.name}')" class="btn btn-xs btn-outline btn-info text-[10px] font-tech" data-tip="Clone / copy model\nSaves to same node under a new name">
              CLONE
            </button>
            <button onclick="deleteSingleModel('${model.name}')" class="btn btn-xs btn-ghost text-[#bf616a] hover:bg-[#bf616a]/15 p-1" data-tip="Delete model from active node">
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
      <td colspan="6" class="text-center py-8 text-[#bf616a]/80 font-semibold italic text-xs">
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
  // Operate on the current sorted page slice
  const sorted = _sortedModels();
  const start = (inventoryPage - 1) * inventoryPageSize;
  const pageModels = sorted.slice(start, start + inventoryPageSize);
  if (checkbox.checked) {
    pageModels.forEach(m => selectedModels.add(m.name));
  } else {
    pageModels.forEach(m => selectedModels.delete(m.name));
  }
  renderModels();
  updateBatchActionsUI();
}

function selectAllPagesModels() {
  models.forEach(m => selectedModels.add(m.name));
  renderModels();
  updateBatchActionsUI();
}

function clearModelSelection() {
  selectedModels.clear();
  renderModels();
  updateBatchActionsUI();
}

function updateBatchActionsUI() {
  const container = document.getElementById('batch-actions-container');
  const countSpan  = document.getElementById('selected-count');
  const allPagesEl = document.getElementById('select-all-pages-hint');

  if (selectedModels.size > 0) {
    container.classList.remove('hidden');
    countSpan.textContent = selectedModels.size;
    // Show "select all N" hint only when there are unselected models on other pages
    if (allPagesEl) {
      const allSelected = models.every(m => selectedModels.has(m.name));
      if (!allSelected && models.length > inventoryPageSize) {
        allPagesEl.classList.remove('hidden');
        const allPagesLink = document.getElementById('select-all-pages-link');
        if (allPagesLink) allPagesLink.textContent = `Select all ${models.length}`;
      } else {
        allPagesEl.classList.add('hidden');
      }
    }
  } else {
    container.classList.add('hidden');
    if (allPagesEl) allPagesEl.classList.add('hidden');
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
  if (!await showConfirm(`Are you sure you want to delete model '${name}'?`)) return;

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

  if (!await showConfirm(`Are you sure you want to delete the ${namesToDelete.length} selected models?`)) return;

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
  const tabs = ['modelfile', 'parameters', 'template', 'system', 'card', 'notes'];
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
  const tabs = ['modelfile', 'parameters', 'template', 'system', 'card', 'notes'];
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
  const notesArea = document.getElementById('model-notes-area');
  const copyBtn = document.getElementById('detail-copy-btn');

  if (activeDetailTab === 'notes') {
    tabContent.classList.add('hidden');
    if (copyBtn) copyBtn.classList.add('hidden');
    if (notesArea) {
      notesArea.classList.remove('hidden');
      const noteKey = 'model-note::' + inspectedModel.name;
      notesArea.value = getPref(noteKey) || localStorage.getItem(noteKey) || '';
    }
    return;
  }

  tabContent.classList.remove('hidden');
  if (copyBtn) copyBtn.classList.remove('hidden');
  if (notesArea) notesArea.classList.add('hidden');

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

function saveModelNote() {
  const notesArea = document.getElementById('model-notes-area');
  if (!notesArea || !inspectedModel) return;
  const key = 'model-note::' + inspectedModel.name;
  const val = notesArea.value;
  // Instant localStorage write for snappy perceived saves
  if (val.trim()) {
    localStorage.setItem(key, val);
  } else {
    localStorage.removeItem(key);
  }
  // Debounced server-side persistence (500ms quiet period)
  clearTimeout(_notesSaveTimer);
  _notesSaveTimer = setTimeout(() => {
    if (val.trim()) {
      setPref(key, val);
    } else {
      // Clear the pref by setting empty — setPref handles the PUT
      setPref(key, '');
    }
  }, 500);
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
          <div class="chat-header text-[10px] text-[#4c566a] mb-1 flex items-center gap-2 justify-end">
            <button onclick="branchFromMessage(${msgIndex})"
              title="Re-prompt — remove this and all later messages, restore text to input"
              class="opacity-30 hover:opacity-100 transition-opacity text-[#b48ead] cursor-pointer text-[10px]">
              <i class="fa-solid fa-code-branch"></i>
            </button>
            <button id="copy-msg-${msgIndex}" onclick="copyMessageToClipboard(${msgIndex})"
              title="Copy message"
              class="opacity-30 hover:opacity-100 transition-opacity text-[#88c0d0] cursor-pointer text-[10px]">
              <i class="fa-regular fa-copy"></i>
            </button>
            <span>USER // DEV</span>
          </div>
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
            <button onclick="branchFromMessage(${msgIndex + 1})"
              title="Re-roll — remove everything after this response and try again"
              class="opacity-30 hover:opacity-100 transition-opacity text-[#b48ead] cursor-pointer text-[10px]">
              <i class="fa-solid fa-code-branch"></i>
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

  // Auto-title on the first user message
  if (chatMessages.length === 1 && activeChatId) {
    autoTitleChat(activeChatId, promptText);
  }

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
    rag_top_k: ragTopK,
    rag_collection: document.getElementById('chat-rag-collection')?.value || '',
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
  input.className = 'input input-xs border border-[#4c566a] bg-[#2e3440]/60 font-mono text-[10px] w-full focus:outline-none builder-adapter-input';
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

  // Regenerate preview and update ctx warning
  generateModelfilePreview();
  updateCtxWarning('builder-base-select', 'builder-ctx-select', 'builder-ctx-warn');
}

// Validate builder name field inline — called on every keystroke and before compile.
// Returns true if valid (proceed), false if invalid (abort).
function builderValidateName() {
  const nameEl      = document.getElementById('builder-name-input');
  const collisionEl = document.getElementById('builder-name-collision');
  const invalidEl   = document.getElementById('builder-name-invalid');
  if (!nameEl) return true;

  const name = nameEl.value.trim().toLowerCase();
  const validPattern = /^[a-z0-9][a-z0-9-_.:]*$/;
  const isInvalid  = name.length > 0 && !validPattern.test(name);
  const isCollision = name.length > 0 && validPattern.test(name) && models.some(m => m.name === name || m.name === `${name}:latest`);

  if (collisionEl) collisionEl.classList.toggle('hidden', !isCollision);
  if (invalidEl)   invalidEl.classList.toggle('hidden', !isInvalid);

  // Border feedback
  nameEl.classList.toggle('border-[#bf616a]', isInvalid);
  nameEl.classList.toggle('border-[#ebcb8b]', isCollision && !isInvalid);
  nameEl.classList.toggle('border-[#4c566a]', !isInvalid && !isCollision);

  return !isInvalid; // collision is a warning, not a hard block
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
    builderValidateName();
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
  if (!await showConfirm(msg)) return;
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
      <div data-chat-id="${chat.id}" class="p-2 border rounded-lg flex items-center justify-between gap-2 transition-all cursor-pointer ${activeBorder} group" onclick="switchChatSession(${chat.id})">
        <div class="flex-1 min-w-0">
          <h3 class="chat-title-text font-bold text-xs truncate group-hover:text-[#88c0d0] transition-colors">${escapeHTML(chat.title)}</h3>
          <p class="text-[9px] font-mono text-[#4c566a] truncate flex justify-between gap-1 mt-0.5">
            <span class="truncate">${escapeHTML(chat.model)}</span>
            <span class="shrink-0">${dateStr}</span>
          </p>
        </div>
        <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <button onclick="startChatRename(${chat.id}, ${JSON.stringify(chat.title)}, event)" class="btn btn-ghost btn-xs p-1 text-[#88c0d0]" title="Rename">
            <i class="fa-solid fa-pencil text-[10px]"></i>
          </button>
          <button onclick="deleteChatSession(${chat.id}, event)" class="btn btn-ghost btn-xs p-1 text-[#bf616a]" title="Delete Session">
            <i class="fa-solid fa-trash-can text-[10px]"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

// ── Chat Title ───────────────────────────────────────────────────────────────

async function autoTitleChat(chatId, promptText) {
  let title = promptText.replace(/\s+/g, ' ').trim();
  if (title.length > 60) {
    title = title.slice(0, 60).replace(/\s+\S*$/, '').trim();
  }
  if (!title) return;
  try {
    await fetch(`/api/chats/${chatId}/title`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    });
    const session = chatSessions.find(c => c.id === chatId);
    if (session) session.title = title;
    renderChatSessions();
    const el = document.getElementById('chat-session-active-title');
    if (el) el.textContent = title.toUpperCase();
  } catch { /* cosmetic — silent */ }
}

async function saveChatRename(chatId, newTitle) {
  const title = newTitle.trim();
  if (!title) return;
  try {
    const res = await fetch(`/api/chats/${chatId}/title`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    });
    if (!res.ok) throw new Error();
    const session = chatSessions.find(c => c.id === chatId);
    if (session) session.title = title;
    renderChatSessions();
    if (chatId === activeChatId) {
      const el = document.getElementById('chat-session-active-title');
      if (el) el.textContent = title.toUpperCase();
    }
  } catch {
    showToast('Rename failed', 'error');
    renderChatSessions();
  }
}

function startChatRename(chatId, currentTitle, event) {
  event.stopPropagation();
  const item = event.target.closest('[data-chat-id]');
  if (!item) return;
  const titleEl = item.querySelector('.chat-title-text');
  if (!titleEl) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentTitle;
  input.className = 'bg-transparent border-b border-[#88c0d0] text-xs text-[#d8dee9] outline-none w-full font-bold';
  input.onclick = e => e.stopPropagation();
  input.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.dataset.cancelled = '1'; input.blur(); }
  };
  input.onblur = () => {
    if (input.dataset.cancelled) { renderChatSessions(); return; }
    saveChatRename(chatId, input.value);
  };
  titleEl.replaceWith(input);
  input.focus();
  input.select();
}

// ── Chat FTS5 Search ──────────────────────────────────────────────────────────
let chatSearchTimer = null;

function onChatSearch(query) {
  const clearBtn  = document.getElementById('chat-search-clear');
  const resultsEl = document.getElementById('chat-search-results');
  const listEl    = document.getElementById('chat-sessions-list');
  if (clearBtn) clearBtn.classList.toggle('hidden', !query);
  clearTimeout(chatSearchTimer);
  if (!query.trim()) {
    if (resultsEl) { resultsEl.classList.add('hidden'); resultsEl.innerHTML = ''; }
    if (listEl) listEl.classList.remove('hidden');
    return;
  }
  chatSearchTimer = setTimeout(() => runChatSearch(query.trim()), 300);
}

async function runChatSearch(query) {
  const resultsEl = document.getElementById('chat-search-results');
  const listEl    = document.getElementById('chat-sessions-list');
  if (!resultsEl) return;
  resultsEl.classList.remove('hidden');
  if (listEl) listEl.classList.add('hidden');
  resultsEl.innerHTML = '<div class="text-[#4c566a] py-2 text-center animate-pulse">Searching…</div>';
  try {
    const res = await fetch(`/api/chats/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error('Search failed');
    renderChatSearchResults(await res.json());
  } catch {
    resultsEl.innerHTML = '<div class="text-[#bf616a] py-2 text-center">Search failed</div>';
  }
}

function renderChatSearchResults(results) {
  const resultsEl = document.getElementById('chat-search-results');
  if (!resultsEl) return;
  if (!results || results.length === 0) {
    resultsEl.innerHTML = '<div class="text-[#4c566a] py-2 text-center">No results</div>';
    return;
  }
  resultsEl.innerHTML = results.map(r => {
    // HTML-escape the raw snippet, then safely swap our server-side markers for <mark> tags
    const snippet = escapeHTML(r.snippet)
      .replace(/\{\{HL_S\}\}/g, '<mark class="chat-search-mark">')
      .replace(/\{\{HL_E\}\}/g, '</mark>');
    return `
      <button onclick="switchChatSession(${r.chat_id}); clearChatSearch();"
        class="w-full text-left p-2 rounded-lg bg-[#2e3440]/60 hover:bg-[#3b4252] border border-[#4c566a]/30 hover:border-[#88c0d0]/40 transition-all">
        <div class="text-[#d8dee9] text-[10px] truncate font-semibold mb-0.5">${escapeHTML(r.chat_title)}</div>
        <div class="text-[#9ca3af] text-[9px] leading-snug line-clamp-2">${snippet}</div>
      </button>
    `;
  }).join('');
}

function clearChatSearch() {
  const input = document.getElementById('chat-search-input');
  if (input) { input.value = ''; onChatSearch(''); }
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

  if (!await showConfirm('Are you sure you want to delete this chat session?')) return;

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

  if (!await showConfirm(`Are you sure you want to delete preset '${preset.name}'?`)) return;

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
  vision:    { label: 'VIS',    cls: 'border-[#b48ead] text-[#b48ead]', icon: 'fa-eye',         title: 'Vision / multimodal' },
  embedding: { label: 'EMB',    cls: 'border-[#ebcb8b] text-[#ebcb8b]', icon: 'fa-layer-group', title: 'Embedding model' },
  tools:     { label: 'TOOLS',  cls: 'border-[#a3be8c] text-[#a3be8c]', icon: 'fa-wrench',      title: 'Tool / function calling' },
  thinking:  { label: 'THINK',  cls: 'border-[#8fbcbb] text-[#8fbcbb]', icon: 'fa-lightbulb',   title: 'Chain-of-thought / reasoning' },
  moe:       { label: 'MoE',    cls: 'border-[#d08770] text-[#d08770]', icon: 'fa-network-wired', title: 'Mixture of Experts' },
  code:      { label: 'CODE',   cls: 'border-[#88c0d0] text-[#88c0d0]', icon: 'fa-code',         title: 'Code-focused model' },
  reasoning: { label: 'REASON', cls: 'border-[#a3be8c] text-[#a3be8c]', icon: 'fa-brain',        title: 'Reasoning / math' },
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
      return `<span class="inline-flex items-center gap-0.5 border ${b.cls} rounded px-1 text-[7px] font-mono font-bold" title="${b.title || b.label}"><i class="fa-solid ${b.icon} text-[6px]"></i>${b.label}</span>`;
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

async function applyPromptTemplate() {
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
    if (await showConfirm("Would you like to overwrite the current input? (Click Cancel to append instead)", "Apply Template")) {
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
    if (grid) grid.innerHTML = `<div class="text-center py-8 text-[#bf616a]/80 text-xs col-span-full"><i class="fa-solid fa-circle-exclamation mr-1.5"></i>${escapeHTML(e.message)}</div>`;
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

    let vramSection = "";
    let activeModelsList = "";
    if (isOnline) {
      const agent = node.agent_metrics;

      // ── CPU + RAM bars from neuro-agent ───────────────────────────────────
      let agentSection = '';
      if (agent) {
        const cpuPct = Math.min(100, agent.cpu.usage_percent || 0);
        const cpuColor = cpuPct > 85 ? '#bf616a' : cpuPct > 60 ? '#ebcb8b' : '#a3be8c';
        const ramUsedGB  = agent.memory.used_bytes / (1024 ** 3);
        const ramTotalGB = agent.memory.total_bytes / (1024 ** 3);
        const ramPct     = ramTotalGB > 0 ? Math.min(100, (ramUsedGB / ramTotalGB) * 100) : 0;
        const ramColor   = ramPct > 85 ? '#bf616a' : ramPct > 60 ? '#ebcb8b' : '#a3be8c';
        agentSection = `
          <div class="flex flex-col gap-1.5 text-[9px] font-mono mt-1 border-t border-[#4c566a]/20 pt-2">
            <div class="flex flex-col gap-0.5">
              <div class="flex justify-between text-[#4c566a]">
                <span>CPU <span class="text-[#4c566a]/70">${escapeHTML(agent.cpu.model.replace(/\(.*?\)/g,'').trim())}</span></span>
                <span style="color:${cpuColor}">${cpuPct.toFixed(0)}%</span>
              </div>
              <div class="w-full bg-[#3b4252] rounded-full h-1 overflow-hidden">
                <div class="h-1 rounded-full transition-all" style="width:${cpuPct}%;background:${cpuColor}"></div>
              </div>
            </div>
            <div class="flex flex-col gap-0.5">
              <div class="flex justify-between text-[#4c566a]">
                <span>RAM</span>
                <span style="color:${ramColor}">${ramUsedGB.toFixed(1)} / ${ramTotalGB.toFixed(1)} GB</span>
              </div>
              <div class="w-full bg-[#3b4252] rounded-full h-1 overflow-hidden">
                <div class="h-1 rounded-full transition-all" style="width:${ramPct}%;background:${ramColor}"></div>
              </div>
            </div>
          </div>`;
      }

      // ── VRAM bar: prefer agent discrete GPU data, fall back to Ollama /api/ps ─
      // Include discrete GPUs even if VRAM is unknown (0) — better to show the
      // card name than silently hide it (VFIO passthrough hosts can't read BAR).
      const agentGPUs = agent ? (agent.gpus || []).filter(g => !g.integrated) : [];
      let ollamaVRAMBytes = 0;
      if (node.active_models && node.active_models.length) {
        ollamaVRAMBytes = node.active_models.reduce((acc, m) => acc + (m.size_vram || 0), 0);
      }

      if (agentGPUs.length > 0) {
        // Real per-GPU VRAM from neuro-agent
        vramSection = agentSection + agentGPUs.map(gpu => {
          const hasVRAM = gpu.vram_total_bytes > 0;
          const usedGB  = gpu.vram_used_bytes / (1024 ** 3);
          const totalGB = gpu.vram_total_bytes / (1024 ** 3);
          const pct     = hasVRAM ? Math.min(100, (usedGB / totalGB) * 100) : 0;
          const color   = pct > 85 ? '#bf616a' : pct > 60 ? '#ebcb8b' : '#88c0d0';
          const label   = hasVRAM
            ? `${usedGB.toFixed(1)} / ${totalGB.toFixed(1)} GB (${pct.toFixed(0)}%)`
            : `<span class="text-[#4c566a]">N/A</span>`;
          return `
            <div class="flex flex-col gap-0.5 text-[9px] font-mono mt-1">
              <div class="flex justify-between text-[#4c566a]">
                <span>VRAM <span class="text-[#4c566a]/70">${escapeHTML(gpu.name.replace(/\(.*?\)/g,'').trim())}</span></span>
                <span style="color:${hasVRAM ? color : 'inherit'}">${label}</span>
              </div>
              ${hasVRAM ? `
              <div class="w-full bg-[#3b4252] rounded-full h-1 overflow-hidden">
                <div class="h-1 rounded-full transition-all" style="width:${pct}%;background:${color}"></div>
              </div>` : ''}
            </div>`;
        }).join('');
      } else {
        // Fallback: Ollama /api/ps loaded bytes + optional manual VramGB
        vramSection = agentSection;
        const totalVRAMGB = ollamaVRAMBytes / (1024 ** 3);
        if (node.vram_gb > 0) {
          const pct = Math.min(100, (totalVRAMGB / node.vram_gb) * 100);
          const color = pct > 85 ? '#bf616a' : pct > 60 ? '#ebcb8b' : '#88c0d0';
          vramSection += `
            <div class="flex flex-col gap-0.5 text-[9px] font-mono mt-1">
              <div class="flex justify-between text-[#4c566a]">
                <span>VRAM</span>
                <span style="color:${color}">${totalVRAMGB.toFixed(1)} / ${node.vram_gb.toFixed(0)} GB (${pct.toFixed(0)}%)</span>
              </div>
              <div class="w-full bg-[#3b4252] rounded-full h-1 overflow-hidden">
                <div class="h-1 rounded-full transition-all" style="width:${pct}%;background:${color}"></div>
              </div>
            </div>`;
        } else if (totalVRAMGB > 0) {
          vramSection += `
            <div class="flex justify-between text-[9px] font-mono mt-1 text-[#4c566a]">
              <span>VRAM</span><span class="text-[#d8dee9]">${totalVRAMGB.toFixed(1)} GB loaded</span>
            </div>`;
        }
      }

      // Active Models Detailed list with Unload action
      if (node.active_models && node.active_models.length) {
        activeModelsList = `
          <div class="flex flex-col gap-1.5 border-t border-[#4c566a]/20 pt-2 mt-1">
            <p class="text-[8px] font-tech text-[#88c0d0] uppercase tracking-wider font-bold">Loaded Models</p>
            <div class="space-y-1">
              ${node.active_models.map(m => {
                const modelVramGB = (m.size_vram || 0) / (1024 * 1024 * 1024);
                const modelShortName = m.name.replace(/:latest$/, '');
                return `
                  <div class="flex items-center justify-between bg-[#2e3440]/40 rounded px-1.5 py-1 text-[9px] font-mono border border-[#4c566a]/20">
                    <span class="text-[#d8dee9] truncate w-24" title="${escapeHTML(m.name)}">${escapeHTML(modelShortName)}</span>
                    <div class="flex items-center gap-1.5 shrink-0">
                      <span class="text-[#4c566a]">${modelVramGB.toFixed(1)} GB</span>
                      <button onclick="unloadNodeModel('${escapeHTML(node.id)}', '${escapeHTML(m.name)}')" 
                              class="btn btn-ghost btn-xs text-[#bf616a] hover:bg-[#bf616a]/20 p-0 h-4 min-h-0 w-4 rounded flex items-center justify-center" 
                              title="Unload Model">
                        <i class="fa-solid fa-power-off text-[8px]"></i>
                      </button>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        `;
      } else {
        activeModelsList = `
          <div class="flex flex-col gap-1 border-t border-[#4c566a]/20 pt-2 mt-1 text-[9px] font-mono italic text-[#4c566a] text-center">
            No models loaded in VRAM
          </div>
        `;
      }
    }

    return `
      <div class="tech-panel rounded-xl p-3 border ${border} flex flex-col gap-2 transition-all group relative min-h-[190px]">
        <!-- Status + name row -->
        <div class="flex items-start justify-between gap-2">
          <div class="flex items-center gap-2 min-w-0">
            <span class="h-2 w-2 rounded-full shrink-0 ${dotColor}"></span>
            <div class="min-w-0">
              <p class="font-bold text-xs text-[#e5e9f0] truncate" title="${escapeHTML(node.name)}">${escapeHTML(node.name)}</p>
              <p class="text-[9px] font-mono text-[#4c566a] truncate" title="${escapeHTML(node.url)}">${escapeHTML(node.url)}</p>
            </div>
          </div>
          ${isActive ? '<span class="shrink-0 text-[8px] font-mono font-bold text-[#88c0d0] border border-[#88c0d0]/40 rounded px-1 py-0.5">ACTIVE</span>' : ''}
        </div>

        <!-- Stats row -->
        <div class="grid grid-cols-2 gap-x-3 gap-y-1 text-[9px] font-mono">
          <div class="text-[#4c566a]">Status</div>
          <div class="${isOnline ? 'text-[#a3be8c]' : 'text-[#bf616a]'} font-semibold uppercase">${escapeHTML(node.status)}</div>

          <div class="text-[#4c566a]">Latency</div>
          <div class="text-[#d8dee9]">${isOnline ? escapeHTML(String(node.latency_ms)) + ' ms' : '—'}</div>

          <div class="text-[#4c566a]">Version</div>
          <div class="text-[#d8dee9] truncate">${escapeHTML(node.version || '—')}</div>

          <div class="text-[#4c566a]">Models</div>
          <div class="text-[#d8dee9]">${escapeHTML(String(node.model_count ?? '—'))}</div>

          ${node.agent_metrics ? (() => {
            const av = node.agent_metrics.agent_version || '';
            const outdated = expectedAgentVersion && av && av !== expectedAgentVersion;
            const vColor = outdated ? 'text-[#ebcb8b]' : 'text-[#88c0d0]';
            const badge = outdated ? ` <span class="text-[#ebcb8b] text-[8px]" title="Expected ${escapeHTML(expectedAgentVersion)}">▲</span>` : '';
            return `<div class="text-[#4c566a]">Agent</div>
          <div class="${vColor} truncate font-mono">${escapeHTML(av || '—')}${badge}</div>`;
          })() : ''}

          <div class="text-[#4c566a]">Updated</div>
          <div class="text-[#4c566a]">${escapeHTML(seenAgo)}</div>
        </div>

        ${vramSection}
        ${activeModelsList}

        <!-- Action row -->
        <div class="flex items-center gap-1 pt-1 border-t border-[#4c566a]/20 mt-auto">
          ${!isActive ? `
            <button onclick="selectServer('${escapeHTML(node.id)}')" class="btn btn-xs btn-outline btn-info flex-1 font-tech text-[9px] h-6 min-h-0">
              SET ACTIVE
            </button>` : `
            <span class="flex-1 text-[9px] font-mono text-[#88c0d0] text-center py-1">Active node</span>`}
          ${isOnline ? (() => {
            const av = node.agent_metrics?.agent_version;
            const agentOutdated = expectedAgentVersion && av && av !== expectedAgentVersion;
            const btnColor = agentOutdated ? 'text-[#ebcb8b] hover:text-[#d08770]' : 'text-[#4c566a] hover:text-[#ebcb8b]';
            const tipText = agentOutdated ? `Update agent (${av} → ${expectedAgentVersion})` : (node.agent_metrics ? 'Update agent' : 'Deploy agent');
            return `<button onclick="openAgentDeployForNode('${escapeHTML(node.id)}')" class="btn btn-xs btn-ghost ${btnColor} p-1 h-6 min-h-0" title="${escapeHTML(tipText)}">
            <i class="fa-solid fa-satellite-dish text-[9px]"></i>
          </button>`;
          })() : ''}
          <button onclick="refreshNode('${escapeHTML(node.id)}')" class="btn btn-xs btn-ghost text-[#4c566a] hover:text-[#88c0d0] p-1 h-6 min-h-0" title="Refresh">
            <i class="fa-solid fa-rotate text-[9px]"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function openAgentDeployForNode(nodeId) {
  switchWorkspace('fleet');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const sel = document.getElementById('agent-deploy-node');
    if (sel) sel.value = nodeId;

    // Pre-fill SSH fields from stored deploy info (saved on last deploy)
    const srv = servers.find(s => s.id === nodeId);
    if (srv) {
      const userEl = document.getElementById('agent-deploy-ssh-user');
      if (userEl && srv.agentSSHUser) userEl.value = srv.agentSSHUser;

      const portEl = document.getElementById('agent-deploy-ssh-port');
      if (portEl && srv.agentSSHPort) portEl.value = srv.agentSSHPort;

      if (srv.agentSSHKeyID) {
        // Switch to key auth and select the stored key
        toggleAgentDeployAuth('key');
        document.querySelectorAll('input[name="agent-deploy-auth"]').forEach(r => {
          r.checked = r.value === 'key';
        });
        const keyEl = document.getElementById('agent-deploy-key-id');
        if (keyEl) { keyEl.value = srv.agentSSHKeyID; onAgentDeployKeyChange(); }
      }
    }

    const btn = document.getElementById('agent-deploy-btn');
    if (btn) btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
}

async function unloadNodeModel(nodeId, modelName) {
  if (!await showConfirm(`Are you sure you want to unload "${modelName}" from VRAM on this node?`)) {
    return;
  }
  
  try {
    const resp = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName })
    });
    
    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.error || 'Failed to unload model');
    }
    
    showToast(`Model "${modelName}" unload request sent`, 'success');
    // Refresh fleet dashboard immediately
    fetchFleetOverview();
  } catch (e) {
    showToast(e.message, 'error');
  }
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
    listBody.innerHTML = `<tr><td colspan="6" class="text-center py-8 text-[#4c566a] italic text-xs">No models matching "${escapeHTML(q)}" found on any node.</td></tr>`;
    return;
  }

  listBody.innerHTML = results.map(r => {
    const sizeFormatted = formatBytes(r.size);
    const paramSize     = escapeHTML((r.details && r.details.parameter_size) || 'N/A');
    const dateFormatted = r.modified_at ? new Date(r.modified_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
    const isActiveNode  = servers.find(s => s.id === r.node_id)?.isActive;
    const nodeBadgeColor = isActiveNode ? 'border-[#88c0d0] text-[#88c0d0]' : 'border-[#4c566a] text-[#4c566a]';
    const safeName      = escapeHTML(r.name || '');
    const safeNodeName  = escapeHTML(r.node_name || r.node_id || '');
    const safeUrl       = escapeHTML(r.url || '');
    const safeNodeId    = escapeHTML(r.node_id || '');

    return `
      <tr class="hover:bg-[#3b4252]/30 border-b border-[#4c566a]/30 transition-colors">
        <td>
          <span class="badge badge-outline text-[8px] font-mono font-bold ${nodeBadgeColor} whitespace-nowrap"
                title="${safeUrl}">${safeNodeName}</span>
        </td>
        <td>
          <span class="font-bold text-[#e5e9f0] text-xs">${safeName}</span>
          <span class="text-[9px] text-[#4c566a] block">${sizeFormatted} // ${paramSize}</span>
        </td>
        <td class="hidden sm:table-cell text-xs">${sizeFormatted}</td>
        <td class="hidden md:table-cell">
          <span class="badge badge-outline border-[#4c566a] text-[#81a1c1] text-[9px] font-mono">${paramSize}</span>
        </td>
        <td class="hidden lg:table-cell text-[#4c566a] font-mono text-[10px]">${dateFormatted}</td>
        <td>
          ${isActiveNode
            ? `<div class="flex items-center gap-1.5">
                <button onclick="inspectModelFromSearch('${safeName}')" class="btn btn-xs btn-neutral border-[#4c566a] text-[10px] font-tech w-[62px]" title="Inspect">INSPECT</button>
                <button onclick="cloneModelPrompt('${safeName}')" class="btn btn-xs btn-outline btn-info text-[10px] font-tech" title="Clone Model">CLONE</button>
                <button onclick="deleteSingleModel('${safeName}')" class="btn btn-xs btn-ghost text-[#bf616a] hover:bg-[#bf616a]/15 p-1" title="Delete Model"><i class="fa-solid fa-trash-can"></i></button>
               </div>`
            : `<button onclick="selectServer('${safeNodeId}')" class="btn btn-xs btn-outline btn-info text-[9px] font-tech">SET ACTIVE</button>`}
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

// inspectModelFromSearch clears the cross-node search (which restores normal
// inventory rows) then opens the accordion for the model. The setTimeout gives
// renderModels() a tick to populate the correct row IDs before inspectModel()
// tries to scroll to and open them.
function inspectModelFromSearch(name) {
  clearCrossNodeSearch(true);
  setTimeout(() => inspectModel(name), 50);
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
              <span class="badge badge-outline border-[#4c566a] text-[#81a1c1] text-[9px] mt-1 font-mono">${escapeHTML((model.details && model.details.parameter_size) || 'N/A')}</span>
            </div>
            <button onclick="unloadModel('${escapeHTML(model.name)}')" class="btn btn-xs btn-error font-tech text-[9px] gap-1">
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
            <span>${escapeHTML(l.created_at)}</span>
            <span class="${statusColor} font-bold uppercase">${escapeHTML(l.status)}</span>
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

// --- OLLAMA REMOTE UPDATE ---

function populateOllamaUpdateNodeSelect() {
  const sel = document.getElementById('ollama-update-node');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">— select node —</option>';
  servers.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.name} (${s.url})`;
    sel.appendChild(opt);
  });
  if (prev) sel.value = prev;
}

function toggleOllamaUpdateAuth(mode) {
  const passRow = document.getElementById('ollama-update-pass-row');
  if (!passRow) return;
  passRow.classList.toggle('hidden', mode === 'key');
}

async function startOllamaUpdate() {
  const nodeId   = document.getElementById('ollama-update-node')?.value;
  const sshUser  = document.getElementById('ollama-update-ssh-user')?.value?.trim();
  const sshPort  = parseInt(document.getElementById('ollama-update-ssh-port')?.value || '22', 10);
  const sshPass  = document.getElementById('ollama-update-ssh-pass')?.value || '';
  const sudoPass = document.getElementById('ollama-update-sudo-pass')?.value || '';
  const useKey   = document.querySelector('input[name="ollama-update-auth"]:checked')?.value === 'key';

  if (!nodeId)   { showToast('Select a node first', 'warning'); return; }
  if (!sshUser)  { showToast('SSH user is required', 'warning'); return; }

  const btn    = document.getElementById('ollama-update-btn');
  const status = document.getElementById('ollama-update-status');
  const output = document.getElementById('ollama-update-output');

  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Connecting…';
  output.classList.remove('hidden');
  output.innerHTML = '';

  const appendLine = (text, cls = '') => {
    const div = document.createElement('div');
    div.className = cls;
    div.textContent = text;
    output.appendChild(div);
    output.scrollTop = output.scrollHeight;
  };

  try {
    const resp = await fetch('/api/system/ollama-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_id: nodeId, ssh_user: sshUser, ssh_password: sshPass,
                             sudo_password: sudoPass, use_ssh_key: useKey, ssh_port: sshPort,
                             ssh_key_id: document.getElementById('ollama-update-key-id')?.value || '' })
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      appendLine(`Error: ${err.error || resp.statusText}`, 'text-[#bf616a]');
      if (status) status.textContent = 'Failed';
      return;
    }

    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();

      let event = '';
      for (const ln of lines) {
        if (ln.startsWith('event:')) { event = ln.slice(6).trim(); continue; }
        if (!ln.startsWith('data:')) continue;
        const data = ln.slice(5).trim();
        switch (event) {
          case 'status':
            appendLine('▶ ' + data, 'text-[#88c0d0]');
            if (status) status.textContent = data.length > 40 ? data.slice(0, 40) + '…' : data;
            break;
          case 'check': {
            let c; try { c = JSON.parse(data); } catch { break; }
            const icon   = c.passed ? '✔' : (c.fatal ? '✖' : '⚠');
            const cls    = c.passed ? 'text-[#a3be8c]' : c.fatal ? 'text-[#bf616a] font-bold' : 'text-[#ebcb8b]';
            const suffix = c.detail ? ` — ${c.detail}` : '';
            appendLine(`  ${icon} ${c.name}${suffix}`, cls);
            break;
          }
          case 'output':
            if (data) appendLine('  ' + data, 'text-[#d8dee9]/70');
            break;
          case 'error':
            appendLine('✖ ' + data, 'text-[#bf616a] font-bold');
            if (status) status.textContent = 'Failed';
            break;
          case 'done':
            if (data === 'success') {
              appendLine('✔ Update complete!', 'text-[#a3be8c] font-bold');
              if (status) status.textContent = 'Done ✔';
              showToast('Ollama updated successfully', 'success');
            } else {
              if (status) status.textContent = 'Failed ✖';
            }
            break;
        }
        event = '';
      }
    }
  } catch (e) {
    appendLine(`Error: ${e.message}`, 'text-[#bf616a]');
    if (status) status.textContent = 'Error';
  } finally {
    if (btn) btn.disabled = false;
  }
}

// --- AGENT DEPLOY ---

let _agentDeployCreds = null; // last successful deploy credentials

function populateAgentDeployNodeSelect() {
  const sel = document.getElementById('agent-deploy-node');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">— select node —</option>';
  servers.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.name} (${s.url})`;
    sel.appendChild(opt);
  });
  if (prev) sel.value = prev;
}

function toggleAgentDeployAuth(mode) {
  const passRow = document.getElementById('agent-deploy-pass-row');
  if (!passRow) return;
  passRow.classList.toggle('hidden', mode === 'key');
}

function populateAgentDeployKeySelect() {
  const sel = document.getElementById('agent-deploy-key-id');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">— use agent / ~/.ssh/ keys —</option>';
  (sshKeys || []).forEach(k => {
    const opt = document.createElement('option');
    opt.value = k.id;
    opt.textContent = `${k.label} (${k.username})`;
    sel.appendChild(opt);
  });
  if (prev) sel.value = prev;
}

function onAgentDeployKeyChange() {
  const sel = document.getElementById('agent-deploy-key-id');
  const userInput = document.getElementById('agent-deploy-ssh-user');
  if (!sel || !userInput) return;
  const key = (sshKeys || []).find(k => k.id === sel.value);
  if (key && !userInput.value) userInput.value = key.username;
}

function showPullBootstrapCmd() {
  const host = window.location.host;
  const protocol = window.location.protocol;
  const cmd = `curl -sSL -k ${protocol}//${host}/api/fleet/bootstrap | bash`;
  const input = document.getElementById('agent-pull-cmd');
  if (input) input.value = cmd;
  const inst = document.getElementById('agent-pull-instructions');
  if (inst) inst.classList.remove('hidden');
  const creds = document.getElementById('agent-deploy-creds');
  if (creds) creds.classList.add('hidden');
}

function copyPullCmd() {
  const input = document.getElementById('agent-pull-cmd');
  if (!input) return;
  input.select();
  document.execCommand('copy');
  showToast('Bootstrap command copied to clipboard!', 'success');
}

async function startAgentDeploy() {
  const nodeId    = document.getElementById('agent-deploy-node')?.value;
  const sshUser   = document.getElementById('agent-deploy-ssh-user')?.value?.trim();
  const sshPort   = parseInt(document.getElementById('agent-deploy-ssh-port')?.value || '22', 10);
  const sshPass   = document.getElementById('agent-deploy-ssh-pass')?.value || '';
  const sudoPass  = document.getElementById('agent-deploy-sudo-pass')?.value || '';
  const agentPort = parseInt(document.getElementById('agent-deploy-port')?.value || '11435', 10);
  const useKey    = document.querySelector('input[name="agent-deploy-auth"]:checked')?.value === 'key';

  if (!nodeId)  { showToast('Select a node first', 'warning'); return; }
  if (!sshUser) { showToast('SSH user is required', 'warning'); return; }

  const btn    = document.getElementById('agent-deploy-btn');
  const status = document.getElementById('agent-deploy-status');
  const output = document.getElementById('agent-deploy-output');
  const creds  = document.getElementById('agent-deploy-creds');
  const pullInst = document.getElementById('agent-pull-instructions');

  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Connecting…';
  if (creds) creds.classList.add('hidden');
  if (pullInst) pullInst.classList.add('hidden');
  _agentDeployCreds = null;
  output.innerHTML = '';

  const appendLine = (text, cls = '') => {
    const div = document.createElement('div');
    div.className = cls;
    div.textContent = text;
    output.appendChild(div);
    output.scrollTop = output.scrollHeight;
  };

  try {
    const resp = await fetch(`/api/nodes/${nodeId}/agent-deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ssh_user: sshUser, ssh_password: sshPass, sudo_password: sudoPass,
        use_ssh_key: useKey, ssh_port: sshPort, agent_port: agentPort,
        ssh_key_id: document.getElementById('agent-deploy-key-id')?.value || ''
      })
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      appendLine(`Error: ${err.error || resp.statusText}`, 'text-[#bf616a]');
      if (status) status.textContent = 'Failed';
      return;
    }

    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();

      let event = '';
      for (const ln of lines) {
        if (ln.startsWith('event:')) { event = ln.slice(6).trim(); continue; }
        if (!ln.startsWith('data:')) continue;
        const data = ln.slice(5).trim();
        switch (event) {
          case 'status':
            appendLine('▶ ' + data, 'text-[#88c0d0]');
            if (status) status.textContent = data.length > 40 ? data.slice(0, 40) + '…' : data;
            break;
          case 'output':
            if (data) appendLine('  ' + data, 'text-[#d8dee9]/70');
            break;
          case 'error':
            appendLine('✖ ' + data, 'text-[#bf616a] font-bold');
            if (status) status.textContent = 'Failed';
            break;
          case 'agent-credentials': {
            let c; try { c = JSON.parse(data); } catch { break; }
            _agentDeployCreds = c;
            document.getElementById('agent-deploy-creds-key').textContent  = c.api_key     || '';
            document.getElementById('agent-deploy-creds-fp').textContent   = c.fingerprint || '';
            document.getElementById('agent-deploy-creds-port').textContent = c.port        || '';
            if (creds) {
              creds.classList.remove('hidden');
              creds.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
            showToast('Agent credentials ready — click "Apply to Node Settings"', 'success');
            break;
          }
          case 'done':
            if (data === 'success') {
              appendLine('✔ Agent deployed successfully!', 'text-[#a3be8c] font-bold');
              if (status) status.textContent = 'Done ✔';
              showToast('NEURO-AGENT deployed successfully', 'success');
            } else {
              if (status) status.textContent = 'Failed ✖';
            }
            break;
        }
        event = '';
      }
    }
  } catch (e) {
    appendLine(`Error: ${e.message}`, 'text-[#bf616a]');
    if (status) status.textContent = 'Error';
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function applyAgentCredentials() {
  if (!_agentDeployCreds) return;
  const { server_id, api_key, fingerprint, port, ssh_user, ssh_key_id, ssh_port } = _agentDeployCreds;
  const srv = servers.find(s => s.id === server_id);
  if (!srv) { showToast('Server not found', 'error'); return; }

  // Build a minimal payload that only updates agent fields; all other
  // fields carry the existing server values so nothing else changes.
  const payload = {
    name: srv.name, url: srv.url,
    authType: srv.authType || 'none',
    authToken: '', authUsername: srv.authUsername || '',
    authPassword: '', authHeaderName: srv.authHeaderName || '',
    authHeaderVal: '', vramGb: srv.vramGb || 0,
    agentPort: port || 11435,
    agentKey: api_key,
    agentFingerprint: fingerprint,
    agentSSHUser: ssh_user || '',
    agentSSHKeyID: ssh_key_id || '',
    agentSSHPort: ssh_port || 22,
  };

  try {
    const resp = await fetch(`/api/servers/${server_id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error((await resp.json().catch(()=>({}))).error || resp.statusText);
    showToast(`Agent credentials saved to ${srv.name}`, 'success');
    await fetchServers();
  } catch (e) {
    showToast(`Failed to save credentials: ${e.message}`, 'error');
  }
}

// --- SSH KEY STORE ---

let sshKeys = []; // cached list (metadata only)

async function fetchSSHKeys() {
  const list = document.getElementById('ssh-keys-list');
  try {
    const res = await fetch('/api/ssh-keys');
    sshKeys = await res.json();
    renderSSHKeys();
    populateOllamaUpdateKeySelect();
    populateAgentDeployKeySelect();
  } catch (e) {
    if (list) list.innerHTML = `<span class="text-[#bf616a]">Failed to load SSH keys: ${escapeHTML(e.message)}</span>`;
  }
}

function renderSSHKeys() {
  const list = document.getElementById('ssh-keys-list');
  if (!list) return;
  if (!sshKeys || sshKeys.length === 0) {
    list.innerHTML = '<span class="text-[#4c566a] italic">No stored keys. Add one to use as a fallback in Docker or agent-less environments.</span>';
    return;
  }
  list.innerHTML = `
    <table class="table table-xs w-full">
      <thead>
        <tr class="text-[#4c566a] text-[9px] uppercase tracking-wider border-b border-[#4c566a]/30">
          <th class="font-mono font-normal pb-1">Label</th>
          <th class="font-mono font-normal pb-1">Username</th>
          <th class="font-mono font-normal pb-1 hidden sm:table-cell">Fingerprint</th>
          <th class="font-mono font-normal pb-1 hidden md:table-cell">Added</th>
          <th></th>
        </tr>
      </thead>
      <tbody class="divide-y divide-[#4c566a]/20">
        ${sshKeys.map(k => `
          <tr>
            <td class="text-[#d8dee9] py-1.5">${escapeHTML(k.label)}</td>
            <td class="text-[#81a1c1] py-1.5">${escapeHTML(k.username)}</td>
            <td class="text-[#4c566a] py-1.5 hidden sm:table-cell text-[9px]">${escapeHTML(k.fingerprint)}</td>
            <td class="text-[#4c566a] py-1.5 hidden md:table-cell text-[9px]">${escapeHTML((k.created_at||'').slice(0,10))}</td>
            <td class="py-1.5 text-right">
              <button onclick="deleteSSHKey('${escapeHTML(k.id)}')"
                      class="btn btn-xs btn-ghost text-[#bf616a] hover:text-[#bf616a]/70 font-mono text-[9px]">
                <i class="fa-solid fa-trash-can"></i>
              </button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function populateOllamaUpdateKeySelect() {
  const sel = document.getElementById('ollama-update-key-id');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">— use agent / ~/.ssh/ keys —</option>';
  (sshKeys || []).forEach(k => {
    const opt = document.createElement('option');
    opt.value = k.id;
    opt.textContent = `${k.label} (${k.username})`;
    sel.appendChild(opt);
  });
  if (prev) sel.value = prev;
}

function onOllamaUpdateKeyChange() {
  const sel = document.getElementById('ollama-update-key-id');
  const userInput = document.getElementById('ollama-update-ssh-user');
  if (!sel || !userInput) return;
  const key = (sshKeys || []).find(k => k.id === sel.value);
  if (key && !userInput.value) userInput.value = key.username;
}

function openAddSSHKeyModal() {
  document.getElementById('ssh-key-label').value = '';
  document.getElementById('ssh-key-username').value = '';
  document.getElementById('ssh-key-pem').value = '';
  document.getElementById('ssh-key-error').classList.add('hidden');
  document.getElementById('ssh-key-submit-btn').disabled = false;
  document.getElementById('add-ssh-key-modal').showModal();
}

function onSSHKeyFileSelect(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => { document.getElementById('ssh-key-pem').value = e.target.result; };
  reader.readAsText(file);
}

async function submitAddSSHKey(e) {
  e.preventDefault();
  const label   = document.getElementById('ssh-key-label').value.trim();
  const username = document.getElementById('ssh-key-username').value.trim();
  const pem     = document.getElementById('ssh-key-pem').value.trim();
  const errEl   = document.getElementById('ssh-key-error');
  const btn     = document.getElementById('ssh-key-submit-btn');

  errEl.classList.add('hidden');
  btn.disabled = true;

  try {
    const res = await fetch('/api/ssh-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, username, pem_content: pem })
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || 'Failed to store key';
      errEl.classList.remove('hidden');
      return;
    }
    document.getElementById('add-ssh-key-modal').close();
    showToast(`SSH key "${label}" stored`, 'success');
    await fetchSSHKeys();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
}

async function deleteSSHKey(id) {
  const key = (sshKeys || []).find(k => k.id === id);
  if (!await showConfirm(`Delete SSH key "${key?.label || id}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/ssh-keys/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error);
    showToast('SSH key deleted', 'success');
    await fetchSSHKeys();
  } catch (e) {
    showToast(`Delete failed: ${e.message}`, 'error');
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
 * Returns capability strings for a model.
 * Prefers authoritative data from /api/show (stored in modelCapabilities),
 * falls back to name/family heuristics.
 * Possible values: 'vision', 'embedding', 'tools', 'thinking', 'llm'
 */
function getModelCapabilities(model) {
  const name    = (model.name || '').toLowerCase();
  const fromAPI = modelCapabilities[model.name];

  // --- Authoritative: use Ollama-reported capabilities when available ---
  if (fromAPI && fromAPI.length > 0) {
    const caps = [];
    if (fromAPI.includes('vision'))    caps.push('vision');
    if (fromAPI.includes('embedding')) caps.push('embedding');
    if (fromAPI.includes('tools'))     caps.push('tools');
    if (fromAPI.includes('thinking'))  caps.push('thinking');
    if (!caps.includes('embedding'))   caps.push('llm');
    return caps;
  }

  // --- Heuristic fallback ---
  const caps     = [];
  const families = (model.details && model.details.families) || [];

  // Vision: Ollama sets 'clip' family for multimodal models
  if (families.some(f => f === 'clip') ||
      /llava|gemma3|minicpm[\-_]v|bakllava|moondream|cogvlm|internvl|vision|qwen.*vl|phi.*vision|pixtral/.test(name)) {
    caps.push('vision');
  }
  // Embedding: Ollama sets 'bert' / 'nomic-bert' families
  if (families.some(f => /bert/.test(f)) ||
      /embed|nomic|mxbai|bge[-_]|e5[-_]|minilm|all-minilm|gte[-_]/.test(name)) {
    caps.push('embedding');
  }
  // Thinking: known reasoning model name patterns
  if (!caps.includes('embedding') &&
      /qwen3|qwq|deepseek-r1|r1-|-r1:|marco-o1|skywork-o1|llama-nemotron/.test(name)) {
    caps.push('thinking');
  }
  // Standard LLM (everything that isn't a pure embedding model)
  if (!caps.includes('embedding')) caps.push('llm');
  return caps;
}

// --- INFERENCE BENCHMARKER ---

let benchmarkEventSource = null;
let benchmarkStartTime   = null;
let currentBenchmarkType = 'standard';

// Batch benchmark state
let batchQueue   = []; // ordered model names
let batchIdx     = 0;  // index of current/next model
let batchRunning = false;
let currentLbFilter      = 'all';
let currentScoreFilter   = 'all'; // grade filter: 'S'|'A'|'B'|'C'|'F'|'all'

// Benchmark model-select filters
let benchUntestedFilter  = false;
let nvnUntestedFilter    = false;
let nvnTestedModels      = {}; // bench_type → Set<model_name>, populated on first untested toggle
let codeUntestedFilter   = false;
let codeTestedModels     = new Set();
let halluUntestedFilter  = false;
let halluTestedModels    = new Set();
let benchParamSliderIdx  = 7;   // index into PARAM_STEPS; 7 = All
const PARAM_STEPS  = [0.5, 1, 3, 7, 13, 30, 70, Infinity];
const PARAM_LABELS = ['≤0.5B', '≤1B', '≤3B', '≤7B', '≤13B', '≤30B', '≤70B', 'All'];
// Tested model names per benchmark type — populated from leaderboard fetch
const testedModelsByType = {}; // { standard: Set<name>, embedding: Set<name>, … }

const BENCH_TYPES = ['standard', 'vision', 'embedding', 'longctx', 'reasoning', 'tool_use', 'json_output', 'instruction_follow'];
const BENCH_TYPE_HINTS = {
  standard:            'Any LLM model — inference speed test',
  vision:              'Requires multimodal model (e.g. llava, gemma3, minicpm-v)',
  embedding:           'Requires embedding model (e.g. nomic-embed-text, mxbai-embed)',
  longctx:             'LLM with large context window recommended (≥8K)',
  reasoning:           'Any LLM — factual accuracy & math test',
  tool_use:            'Requires TOOLS capability — tests function call selection and parameter extraction',
  json_output:         'Any LLM — tests structured JSON output via format:json',
  instruction_follow:  'Any LLM — tests constraint compliance; judge model evaluates each response',
};

// Param size filter state for the leaderboard (0 = no bound)
let lbParamMin = 0;
let lbParamMax = 0;
// Chart view toggle for the leaderboard
let lbChartActive = false;
// Node filter — true = show only the active node's results across all leaderboards (default ON)
let lbNodeFilter = true;

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

// Returns the list of model names compatible with the current benchmark type + filters.
// Used by both populateBenchmarkModelSelect and startBatchBenchmark.
function getCompatibleBenchmarkModels({ applyUntestedFilter = false } = {}) {
  // 1. Capability filter
  let filtered = models;
  if (currentBenchmarkType === 'vision') {
    filtered = models.filter(m => getModelCapabilities(m).includes('vision'));
  } else if (currentBenchmarkType === 'embedding') {
    filtered = models.filter(m => getModelCapabilities(m).includes('embedding'));
  } else {
    filtered = models.filter(m => getModelCapabilities(m).includes('llm'));
  }
  // 2. Optional untested filter
  if (applyUntestedFilter && benchUntestedFilter) {
    const tested = testedModelsByType[currentBenchmarkType] || new Set();
    filtered = filtered.filter(m => !tested.has(m.name));
  }
  // 3. Param size filter
  const maxParams = PARAM_STEPS[benchParamSliderIdx];
  if (maxParams !== Infinity) {
    filtered = filtered.filter(m => {
      const pb = parseParamBillions((m.details && m.details.parameter_size) || '');
      return pb === null || pb <= maxParams;
    });
  }
  return filtered.map(m => m.name);
}

function populateBenchmarkModelSelect() {
  const select = document.getElementById('benchmark-model-select');
  if (!select) return;

  // Delegate to shared helper; untested filter applies here
  const names = getCompatibleBenchmarkModels({ applyUntestedFilter: true });

  if (names.length === 0) {
    const reason = benchUntestedFilter ? 'untested models' : 'compatible models';
    select.innerHTML = `<option value="">-- No ${reason} found --</option>`;
    return;
  }

  // Build model-object array preserving order; use a Set for O(1) name lookup
  const nameSet   = new Set(names);
  const filtered  = models.filter(m => nameSet.has(m.name));
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
  // Restore node filter state (default ON)
  lbNodeFilter = getPref('neurollama-lb-node-filter', 'true') === 'true';
  _syncLbNodeFilterBtns();
}

function _syncLbNodeFilterBtns() {
  ['lb-node-filter-btn', 'code-node-filter-btn', 'halluc-node-filter-btn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('bench-type-btn-active', lbNodeFilter);
  });
}

function toggleLbNodeFilter() {
  lbNodeFilter = !lbNodeFilter;
  setPref('neurollama-lb-node-filter', lbNodeFilter ? 'true' : 'false');
  _syncLbNodeFilterBtns();
  fetchBenchmarks();
  renderLangLeaderboard();
  renderCodeBenchResults();
  renderHallucLeaderboard();
  renderHallucinationHistory();
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
  const runBtn    = document.getElementById('run-benchmark-btn');
  const runAllBtn = document.getElementById('run-all-benchmark-btn');
  const cancelBtn = document.getElementById('cancel-benchmark-btn');

  if (runBtn) {
    runBtn.disabled = isRunning;
    runBtn.innerHTML = isRunning
      ? '<span class="loading loading-spinner loading-xs mr-1.5"></span>Measuring'
      : '<i class="fa-solid fa-play mr-1.5"></i>Start Measurement';
  }
  if (runAllBtn) runAllBtn.disabled = isRunning;
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

  // Route new functional benchmark types to their dedicated endpoints
  let url;
  if (currentBenchmarkType === 'tool_use') {
    url = `/api/benchmarks/tool-use/run?model=${encodeURIComponent(model)}`;
  } else if (currentBenchmarkType === 'json_output') {
    url = `/api/benchmarks/json-output/run?model=${encodeURIComponent(model)}`;
  } else if (currentBenchmarkType === 'instruction_follow') {
    const judgeEl = document.getElementById('code-judge-model-select');
    const judge = judgeEl?.value || 'same';
    url = `/api/benchmarks/instruction-follow/run?model=${encodeURIComponent(model)}&judge_model=${encodeURIComponent(judge)}`;
  } else {
    url = `/api/benchmarks/run?model=${encodeURIComponent(model)}&type=${encodeURIComponent(currentBenchmarkType)}`;
  }
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
      fetchModelBenchSummary(); // refresh inventory grade badges
      advanceBatchQueue();      // advance to next model if batch is running
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
    advanceBatchQueue(); // skip failed model and continue batch
  };
}

function cancelBenchmark() {
  if (!benchmarkEventSource) return;
  benchmarkEventSource.close();
  benchmarkEventSource = null;
  // Also abort any in-progress batch
  if (batchRunning) {
    batchRunning = false;
    batchQueue   = [];
    batchIdx     = 0;
    updateBatchProgress();
  }
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

// ── Batch benchmark (Run All) ────────────────────────────────────────────────

function startBatchBenchmark() {
  if (batchRunning || benchmarkEventSource) {
    showToast('A benchmark is already running', 'warning');
    return;
  }
  const queue = getCompatibleBenchmarkModels({ applyUntestedFilter: true });
  if (queue.length === 0) {
    showToast('No compatible models for this benchmark type', 'warning');
    return;
  }
  if (queue.length === 1) {
    // Single model — just use the normal start flow
    const sel = document.getElementById('benchmark-model-select');
    if (sel) sel.value = queue[0];
    startBenchmark();
    return;
  }
  batchQueue   = queue;
  batchIdx     = 0;
  batchRunning = true;
  updateBatchProgress();
  _runBatchStep();
}

function _runBatchStep() {
  if (!batchRunning || batchIdx >= batchQueue.length) {
    _finishBatch();
    return;
  }
  const model = batchQueue[batchIdx];
  const sel = document.getElementById('benchmark-model-select');
  if (sel) sel.value = model;
  updateBatchProgress();
  startBenchmark();
}

function advanceBatchQueue() {
  if (!batchRunning) return;
  batchIdx++;
  if (batchIdx >= batchQueue.length) {
    _finishBatch();
  } else {
    // Brief pause so the leaderboard can update before the next run
    setTimeout(_runBatchStep, 800);
  }
}

function _finishBatch() {
  batchRunning = false;
  batchQueue   = [];
  batchIdx     = 0;
  updateBatchProgress();
  showToast('Batch benchmark complete — all models tested!', 'success');
}

function updateBatchProgress() {
  const el   = document.getElementById('batch-progress');
  const text = document.getElementById('batch-progress-text');
  if (!el) return;
  if (!batchRunning || batchQueue.length === 0) {
    el.classList.add('hidden');
    return;
  }
  const done    = batchIdx;
  const total   = batchQueue.length;
  const current = batchQueue[batchIdx] || '';
  const short   = current.split(':')[0];
  if (text) text.textContent = `${done + 1}/${total} · ${short}`;
  el.classList.remove('hidden');
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
    const scoreFiltered = (currentScoreFilter && currentScoreFilter !== 'all')
      ? allGroups.filter(g => g.display_score === currentScoreFilter)
      : allGroups;

    // Client-side node filter — limit to active node when toggle is ON
    const activeNode = activeServerLabel();
    const nodeFiltered = (lbNodeFilter && activeNode)
      ? scoreFiltered.filter(g => g.server_name === activeNode)
      : scoreFiltered;

    // Client-side param size range filter
    const groupList = (lbParamMin || lbParamMax)
      ? nodeFiltered.filter(g => {
          const m = models.find(mo => mo.name === g.model_name);
          const sizeB = m ? parseParamB(m.details?.parameter_size) : null;
          if (sizeB === null) return true; // unknown size — include by default
          if (lbParamMin && sizeB < lbParamMin) return false;
          if (lbParamMax && sizeB > lbParamMax) return false;
          return true;
        })
      : nodeFiltered;

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
        standard:           { short:'STD',  cls:'text-[#88c0d0]', border:'border-[#88c0d0]/40', bg:'bg-[#88c0d0]/8'  },
        vision:             { short:'VIS',  cls:'text-[#b48ead]', border:'border-[#b48ead]/50', bg:'bg-[#b48ead]/8'  },
        embedding:          { short:'EMB',  cls:'text-[#ebcb8b]', border:'border-[#ebcb8b]/40', bg:'bg-[#ebcb8b]/8'  },
        longctx:            { short:'CTX',  cls:'text-[#a3be8c]', border:'border-[#a3be8c]/40', bg:'bg-[#a3be8c]/8'  },
        reasoning:          { short:'RSN',  cls:'text-[#d08770]', border:'border-[#d08770]/50', bg:'bg-[#d08770]/8'  },
        tool_use:           { short:'TOOL', cls:'text-[#8fbcbb]', border:'border-[#8fbcbb]/40', bg:'bg-[#8fbcbb]/8'  },
        json_output:        { short:'JSON', cls:'text-[#81a1c1]', border:'border-[#81a1c1]/40', bg:'bg-[#81a1c1]/8'  },
        instruction_follow: { short:'INS',  cls:'text-[#5e81ac]', border:'border-[#5e81ac]/40', bg:'bg-[#5e81ac]/8'  },
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
      standard:            { label: 'STD',  cls: 'text-[#88c0d0] border-[#88c0d0]' },
      vision:              { label: 'VIS',  cls: 'text-[#b48ead] border-[#b48ead]' },
      embedding:           { label: 'EMB',  cls: 'text-[#ebcb8b] border-[#ebcb8b]' },
      longctx:             { label: 'CTX',  cls: 'text-[#a3be8c] border-[#a3be8c]' },
      reasoning:           { label: 'RSN',  cls: 'text-[#d08770] border-[#d08770]' },
      tool_use:            { label: 'TOOL', cls: 'text-[#8fbcbb] border-[#8fbcbb]' },
      json_output:         { label: 'JSON', cls: 'text-[#81a1c1] border-[#81a1c1]' },
      instruction_follow:  { label: 'INS',  cls: 'text-[#5e81ac] border-[#5e81ac]' },
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
    // sparkHtml: optional sparkline SVG injected after the primary metric value (multi-run summary only).
    function metricCells(sr, bType, sparkHtml = '') {
      let extra = {};
      try { extra = JSON.parse(sr.extra_json || '{}'); } catch (_) {}
      const isAvg = !!sr.is_avg;
      let ttftCell, metricCell, latCell;

      if (bType === 'embedding') {
        const cps = extra.chunks_per_sec != null ? extra.chunks_per_sec.toFixed(1) : '—';
        const rng = (isAvg && sr.min_chunks_per_sec != null && sr.max_chunks_per_sec != null && sr.max_chunks_per_sec !== sr.min_chunks_per_sec)
          ? `<span class="text-[9px] text-[#4c566a] font-normal ml-1">±${((sr.max_chunks_per_sec - sr.min_chunks_per_sec) / 2).toFixed(1)}</span>` : '';
        ttftCell   = `<td class="text-center text-[#4c566a]">—</td>`;
        metricCell = `<td class="text-center font-bold text-[#ebcb8b]">${cps}${rng} <span class="text-[9px] text-[#4c566a] font-normal">ch/s</span>${sparkHtml}</td>`;
        latCell    = `<td class="text-center text-[#4c566a]">—</td>`;
      } else if (bType === 'reasoning') {
        const acc = extra.accuracy_pct != null ? extra.accuracy_pct.toFixed(0) + '%' : '—';
        const rng = (isAvg && sr.min_accuracy_pct != null && sr.max_accuracy_pct != null && sr.max_accuracy_pct !== sr.min_accuracy_pct)
          ? `<span class="text-[9px] text-[#4c566a] font-normal ml-1">±${((sr.max_accuracy_pct - sr.min_accuracy_pct) / 2).toFixed(1)}%</span>` : '';
        ttftCell   = `<td class="text-center text-[#4c566a]">—</td>`;
        metricCell = `<td class="text-center font-bold text-[#a3be8c]">${acc}${rng} <span class="text-[9px] text-[#4c566a] font-normal">acc</span>${sparkHtml}</td>`;
        latCell    = `<td class="text-center">${(sr.avg_latency_ms || 0).toFixed(0)} ms</td>`;
      } else if (bType === 'longctx') {
        const deg    = extra.degradation_pct != null ? extra.degradation_pct.toFixed(1) + '%' : '';
        const degHtml = deg ? ` <span class="text-[9px] text-[#bf616a] font-normal">↓${deg}</span>` : '';
        const rng    = (isAvg && sr.min_tps != null && sr.max_tps != null && sr.max_tps !== sr.min_tps)
          ? `<span class="text-[9px] text-[#4c566a] font-normal ml-1">±${((sr.max_tps - sr.min_tps) / 2).toFixed(1)}</span>` : '';
        ttftCell   = `<td class="text-center">${(sr.ttft_ms || 0).toFixed(1)} ms</td>`;
        metricCell = `<td class="text-center font-bold text-[#88c0d0]">${(sr.tps || 0).toFixed(1)}${degHtml}${rng}${sparkHtml}</td>`;
        latCell    = `<td class="text-center">${(sr.avg_latency_ms || 0).toFixed(0)} ms</td>`;
      } else if (bType === 'tool_use' || bType === 'json_output' || bType === 'instruction_follow') {
        const acc = extra.accuracy_pct != null ? extra.accuracy_pct.toFixed(0) + '%' : '—';
        const COLOR = bType === 'tool_use' ? '#8fbcbb' : bType === 'json_output' ? '#81a1c1' : '#5e81ac';
        ttftCell   = `<td class="text-center text-[#4c566a]">—</td>`;
        metricCell = `<td class="text-center font-bold" style="color:${COLOR}">${acc} <span class="text-[9px] text-[#4c566a] font-normal">acc</span>${sparkHtml}</td>`;
        latCell    = `<td class="text-center text-[#4c566a]">—</td>`;
      } else {
        // standard / vision
        const rng = (isAvg && sr.min_tps != null && sr.max_tps != null && sr.max_tps !== sr.min_tps)
          ? `<span class="text-[9px] text-[#4c566a] font-normal ml-1">±${((sr.max_tps - sr.min_tps) / 2).toFixed(1)}</span>` : '';
        ttftCell   = `<td class="text-center">${(sr.ttft_ms || 0).toFixed(1)} ms</td>`;
        metricCell = `<td class="text-center font-bold text-[#88c0d0]">${(sr.tps || 0).toFixed(1)}${rng} <span class="text-[9px] text-[#4c566a] font-normal">TPS</span>${sparkHtml}</td>`;
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
      const sparkSvg = multiRun ? buildSparkline(group.runs, bType) : '';
      const { ttftCell, metricCell, latCell } = metricCells(group.summary_run, bType, sparkSvg);

      const displayScore = group.display_score || 'F';
      const scoreClass   = scoreBadgeClass(displayScore);
      const autoBadge    = group.is_auto_score
        ? `<span class="text-[8px] text-[#4c566a] font-mono ml-0.5" title="Auto-scored from metrics">auto</span>`
        : '';

      const runsBadge = multiRun
        ? `<span class="ml-1 bg-[#3b4252] border border-[#4c566a] text-[#8fbcbb] text-[8px] font-mono px-1.5 rounded-full">${group.run_count}×</span>`
        : '';

      // Chat-model flag: stored in extra_json when standard benchmark detects greeting response
      const summaryExtra = (() => { try { return JSON.parse(group.summary_run?.extra_json || '{}'); } catch { return {}; } })();
      const isChatModel = Array.isArray(summaryExtra.flags) && summaryExtra.flags.includes('chat_model');
      const chatBadge = isChatModel
        ? `<span onclick="event.stopPropagation(); openModelFixWizard('${escapeHTML(group.model_name)}')" class="inline-flex items-center gap-0.5 border border-[#bf616a]/70 text-[#bf616a] rounded px-1 text-[8px] font-mono font-bold cursor-pointer ml-1 hover:bg-[#bf616a]/10 transition-colors" data-tip="Chat-only model — ignores task prompts\nCode &amp; hallucination benchmarks will score 0\nClick to fix Modelfile →">CHAT⚠ <i class="fa-solid fa-wrench text-[7px]"></i></span>`
        : '';
      const expandBtn = multiRun
        ? `<button onclick="event.stopPropagation();toggleBenchGroup('${gkey}')" id="expand-btn-${gkey}"
                   title="Show individual runs"
                   class="btn btn-xs btn-ghost text-[#4c566a] hover:text-[#88c0d0] hover:bg-[#88c0d0]/15 p-1">
             <i id="expand-icon-${gkey}" class="fa-solid fa-chevron-down text-[10px] transition-transform duration-150"></i>
           </button>`
        : '';

      const userNotes = (group.latest_notes && group.latest_notes !== 'auto') ? group.latest_notes : '';
      // Always render a clickable note area; click to edit inline (single & multi-run rows)
      const noteHtml = userNotes
        ? `<div class="bench-note-area text-[10px] leading-none mt-0.5 cursor-text"
                data-bench-id="${group.latest_id}" data-bench-score="${escapeHTML(displayScore)}" data-bench-notes="${escapeHTML(userNotes)}"
                onclick="event.stopPropagation(); startBenchNoteEdit(this)">
             <span class="max-w-[180px] truncate inline-block text-[#4c566a] hover:text-[#88c0d0]/80 transition-colors">${escapeHTML(userNotes)}</span>
           </div>`
        : `<div class="bench-note-area text-[10px] leading-none mt-0.5 cursor-text"
                data-bench-id="${group.latest_id}" data-bench-score="${escapeHTML(displayScore)}" data-bench-notes=""
                onclick="event.stopPropagation(); startBenchNoteEdit(this)">
             <span class="text-[#3b4252] hover:text-[#4c566a] transition-colors font-mono text-[9px]">+ note</span>
           </div>`;

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
            <div class="flex items-center gap-1.5 overflow-hidden flex-wrap">
              ${typeBadgeHtml}
              <span class="font-bold text-[#e5e9f0] truncate min-w-0" title="${escapeHTML(group.model_name)}">${escapeHTML(group.model_name)}</span>
              ${runsBadge}${chatBadge}
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

          const runNoteHtml = runUserNotes
            ? `<div class="bench-note-area text-[9px] leading-none mt-0.5 cursor-text"
                    data-bench-id="${run.id}" data-bench-score="${escapeHTML(runDisplayScore)}" data-bench-notes="${escapeHTML(runUserNotes)}"
                    onclick="event.stopPropagation(); startBenchNoteEdit(this)">
                 <span class="max-w-[160px] truncate inline-block text-[#4c566a] hover:text-[#88c0d0]/80 transition-colors">${escapeHTML(runUserNotes)}</span>
               </div>`
            : `<div class="bench-note-area text-[9px] leading-none mt-0.5 cursor-text"
                    data-bench-id="${run.id}" data-bench-score="${escapeHTML(runDisplayScore)}" data-bench-notes=""
                    onclick="event.stopPropagation(); startBenchNoteEdit(this)">
                 <span class="text-[#3b4252] hover:text-[#4c566a] transition-colors font-mono" style="font-size:8px">+ note</span>
               </div>`;

          html += `
            <tr id="sub-${gkey}-${idx}" data-group="${gkey}"
                class="bench-sub-row bg-[#2e3440]/60 border-b border-[#4c566a]/10 text-[11px] hidden">
              <td class="py-2 pl-8 font-mono text-[#4c566a]">
                <div>${escapeHTML(runDate)}${newestTag}${verTag}</div>
                ${runNoteHtml}
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

    if (lbChartActive) {
      renderLbChart(groupList);
    } else {
      tbody.innerHTML = html;
    }
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

// Click-to-edit note on a leaderboard row — replaces the display div with an
// <input>, saves on blur/Enter, cancels on Escape.  el must carry data-bench-id,
// data-bench-score, and data-bench-notes attributes.
function startBenchNoteEdit(el) {
  const id           = el.dataset.benchId;
  const currentScore = el.dataset.benchScore || '';
  const currentNotes = el.dataset.benchNotes || '';

  const input = document.createElement('input');
  input.type  = 'text';
  input.value = currentNotes;
  input.placeholder = 'add note…';
  input.className   = 'bg-transparent border-b border-[#4c566a] text-[10px] text-[#d8dee9] ' +
                      'font-mono outline-none focus:border-[#88c0d0] py-0.5 w-[180px] max-w-full';

  el.replaceWith(input);
  input.focus();
  if (currentNotes) input.select();

  let committed = false;

  function buildNoteEl(notes) {
    const div = document.createElement('div');
    div.className = 'bench-note-area text-[10px] leading-none mt-0.5 cursor-text';
    div.dataset.benchId    = id;
    div.dataset.benchScore = currentScore;
    div.dataset.benchNotes = notes;
    div.addEventListener('click', e => { e.stopPropagation(); startBenchNoteEdit(div); });
    if (notes) {
      div.innerHTML = `<span class="max-w-[180px] truncate inline-block text-[#4c566a] hover:text-[#88c0d0]/80 transition-colors">${escapeHTML(notes)}</span>`;
    } else {
      div.innerHTML = `<span class="text-[#3b4252] hover:text-[#4c566a] transition-colors font-mono text-[9px]">+ note</span>`;
    }
    return div;
  }

  function commit(cancel) {
    if (committed) return;
    committed = true;
    const newNotes = cancel ? currentNotes : input.value.trim();
    input.replaceWith(buildNoteEl(newNotes));
    if (!cancel && newNotes !== currentNotes) {
      fetch(`/api/benchmarks/${id}/score`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score: currentScore, notes: newNotes }),
      }).catch(() => {});
    }
  }

  input.addEventListener('blur',    ()  => commit(false));
  input.addEventListener('keydown', e  => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); commit(true); }
  });
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
  if (!await showConfirm('Are you sure you want to delete this benchmark record?')) return;
  
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
  const tabs = ['standard', 'optimizer', 'nodevnode', 'code', 'hallucination'];
  tabs.forEach(t => {
    const btn = document.getElementById(`benchmark-subtab-${t}`);
    const container = document.getElementById(`benchmark-${t}-container`);
    if (btn) btn.classList.toggle('bench-subtab-active', t === tab);
    if (container) container.classList.toggle('hidden', t !== tab);
  });
  if (tab === 'optimizer') loadOptimizerHistory();
  if (tab === 'nodevnode') loadNvnPanel();
  if (tab === 'code') { initCodeBenchLangGrid(); fetchCodeBenchRuns(); fetchCodeCheckerStatus(); }
  if (tab === 'hallucination') { fetchHallucinationRuns(); }
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
  // Re-filter model list when untested is active (tested set is per bench type)
  if (nvnUntestedFilter) populateNvnModelSelect();
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

async function toggleNvnUntestedFilter() {
  nvnUntestedFilter = !nvnUntestedFilter;
  _setNvnFilterBadge('nvn-filter-untested-btn', nvnUntestedFilter);
  if (nvnUntestedFilter) {
    try {
      const r = await fetch('/api/benchmarks/nvn-matches');
      if (r.ok) {
        nvnTestedModels = {};
        (await r.json()).forEach(m => {
          if (!nvnTestedModels[m.bench_type]) nvnTestedModels[m.bench_type] = new Set();
          nvnTestedModels[m.bench_type].add(m.model_name);
        });
      }
    } catch { /* silently ignore — filter will just show all */ }
  }
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

  // Untested filter: remove models that already have NvN results for this type
  if (nvnUntestedFilter) {
    const tested = nvnTestedModels[nvnType] || new Set();
    for (const name of [...seen.keys()]) {
      if (tested.has(name)) seen.delete(name);
    }
  }

  const emptyMsg = nvnFilterBoth      ? '— No shared models on A & B —'
                 : nvnFilterNodeA     ? '— No models on Node A —'
                 : nvnUntestedFilter  ? '— No untested models found —'
                 :                      '— No models found —';

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

  nvnES.addEventListener('done', async () => {
    nvnES.close(); nvnES = null;
    document.getElementById('nvn-run-btn')?.classList.remove('hidden');
    document.getElementById('nvn-stop-btn')?.classList.add('hidden');
    refreshNvnModels().then(updateNvnAvailability);
    fetchBenchmarks(); // refresh standard leaderboard
    loadNvnLeaderboard(); // refresh win/loss board
    fetchModelBenchSummary(); // refresh inventory grade badges
    // Refresh untested filter so the just-tested model disappears from the select
    if (nvnUntestedFilter) {
      try {
        const r = await fetch('/api/benchmarks/nvn-matches');
        if (r.ok) {
          nvnTestedModels = {};
          (await r.json()).forEach(m => {
            if (!nvnTestedModels[m.bench_type]) nvnTestedModels[m.bench_type] = new Set();
            nvnTestedModels[m.bench_type].add(m.model_name);
          });
        }
      } catch { /* ignore */ }
      populateNvnModelSelect();
    }
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
        Failed to load optimization history: ${escapeHTML(error.message)}
      </div>
    `;
  }
}

async function deleteOptimizerRun(id) {
  if (!await showConfirm('Are you sure you want to delete this optimizer run record?')) return;
  
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
      uploadLogs.innerHTML += `<div class="${style}">[${time}] ${escapeHTML(String(msg))}</div>`;
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

  // Duplicate detection: warn if same filename already indexed
  const dupDoc = (await fetch('/api/rag/documents').then(r => r.json()).catch(() => [])).find(d => d.name === file.name);
  if (dupDoc) {
    if (!await showConfirm(`"${file.name}" is already indexed (${dupDoc.chunk_count} chunks, collection: ${dupDoc.collection || 'Default'}).\n\nProceed? This will create a second copy — to replace, delete the existing document first.`)) {
      if (progressDiv) progressDiv.classList.add('hidden');
      return;
    }
  }

  const collection = document.getElementById('rag-collection-input')?.value.trim() || 'Default';

  updateProgress(3, 'Uploading...');
  logMessage(`Uploading ${file.name} (${fileMB.toFixed(1)} MB) → collection: ${collection}`);
  if (fileMB > 20) {
    logMessage(`⚠ Large file — extraction and embedding may take a moment.`);
  }

  try {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('embedding_model', model);
    formData.append('collection', collection);

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
      const probeEscaped = (doc.probe_phrase || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ').trim();
      const modelEscaped = (doc.embedding_model || '').replace(/'/g, "\\'");
      const hasProbe = probeEscaped.length > 0;
      const collection = doc.collection || 'Default';
      html += `
        <tr class="hover:bg-[#3b4252]/20 border-b border-[#4c566a]/20 last:border-none transition-colors">
          <td class="py-2.5 pl-0 font-bold text-[#d8dee9] max-w-[180px] truncate" title="${escapeHTML(doc.name)}">
            <i class="fa-regular fa-file-code text-[#88c0d0] mr-1.5"></i>${escapeHTML(doc.name)}
          </td>
          <td class="py-2.5 text-[#4c566a] text-xs font-mono select-all">${escapeHTML(doc.embedding_model)}</td>
          <td class="py-2.5 hidden sm:table-cell">
            <span class="rag-collection-badge inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-[#4c566a]/50 text-[9px] font-mono text-[#81a1c1] cursor-pointer hover:border-[#88c0d0]/50 transition-colors"
                  title="Click to rename collection"
                  onclick="startRAGCollectionEdit(this, ${doc.id}, '${escapeHTML(collection)}')">${escapeHTML(collection)}</span>
          </td>
          <td class="py-2.5 text-center text-[#88c0d0] font-bold">${doc.chunk_count || 0}</td>
          <td class="py-2.5 text-[#4c566a] text-[10px] hidden md:table-cell">${createdDate}</td>
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
    fetchRAGCollections(); // refresh collection dropdowns after doc list loads
  } catch (error) {
    console.error('Error loading RAG documents:', error);
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="text-center py-6 text-[#bf616a] italic text-xs">
          Failed to load indexed documents: ${escapeHTML(error.message)}
        </td>
      </tr>
    `;
  }
}

async function deleteRAGDocument(id, name) {
  if (!await showConfirm(`Are you sure you want to delete and un-index document "${name}"? This cannot be undone.`)) {
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

// ── RAG Collection Manager ───────────────────────────────────────────────────
let ragCollections = [];

async function fetchRAGCollections() {
  try {
    const res = await fetch('/api/rag/collections');
    if (!res.ok) return;
    ragCollections = await res.json() || [];
    _populateRAGCollectionDropdowns();
    _populateRAGCollectionDatalist();
  } catch { /* silent */ }
}

function _populateRAGCollectionDatalist() {
  const dl = document.getElementById('rag-collection-list');
  if (!dl) return;
  dl.innerHTML = ragCollections.map(c => `<option value="${escapeHTML(c)}">`).join('');
}

function _populateRAGCollectionDropdowns() {
  const opts = '<option value="">All Collections</option>' +
    ragCollections.map(c => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join('');
  ['rag-query-collection', 'chat-rag-collection'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = opts;
    if (prev && sel.querySelector(`option[value="${CSS.escape(prev)}"]`)) sel.value = prev;
  });
}

// Inline collection rename on badge click
function startRAGCollectionEdit(badgeEl, docId, currentCollection) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentCollection;
  input.className = 'input input-xs w-28 bg-[#242933] border-[#88c0d0] font-mono text-[9px] text-[#d8dee9] focus:outline-none';
  input.list = 'rag-collection-list';

  const save = async () => {
    const newCol = input.value.trim() || 'Default';
    if (newCol === currentCollection) { loadRAGDocuments(); return; }
    try {
      const res = await fetch(`/api/rag/documents/${docId}/collection`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: newCol }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      loadRAGDocuments();
    } catch (e) { showToast(e.message, 'error'); loadRAGDocuments(); }
  };

  input.addEventListener('blur', save);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { loadRAGDocuments(); }
  });

  badgeEl.replaceWith(input);
  input.focus();
  input.select();
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

  // Clear collection filter so we're searching all collections for this document
  const collectionSel = document.getElementById('rag-query-collection');
  if (collectionSel) collectionSel.value = '';

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
    const collection = document.getElementById('rag-query-collection')?.value || '';
    const response = await fetch('/api/rag/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: query,
        embedding_model: modelSelect.value,
        top_k: 3,
        collection,
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
        Failed to query similarity: ${escapeHTML(error.message)}
      </div>
    `;
    showToast(error.message, 'error');
  }
}

// ── Code Benchmark ────────────────────────────────────────────────────────────

const CODE_LANGS = [
  { lang: 'python',     label: 'Python',      icon: 'fa-brands fa-python' },
  { lang: 'go',         label: 'Go',          icon: 'fa-brands fa-golang' },
  { lang: 'javascript', label: 'JavaScript',  icon: 'fa-brands fa-js' },
  { lang: 'typescript', label: 'TypeScript',  icon: 'fa-solid fa-t' },
  { lang: 'node',       label: 'Node.js',     icon: 'fa-brands fa-node-js' },
  { lang: 'bash',       label: 'Bash',        icon: 'fa-solid fa-terminal' },
  { lang: 'sh',         label: 'sh (POSIX)',  icon: 'fa-solid fa-hashtag' },
  { lang: 'rust',       label: 'Rust',        icon: 'fa-brands fa-rust' },
  { lang: 'php',        label: 'PHP',         icon: 'fa-brands fa-php' },
  { lang: 'ruby',       label: 'Ruby',        icon: 'fa-solid fa-gem' },
  { lang: 'c',          label: 'C',           icon: 'fa-solid fa-c' },
  { lang: 'sql',        label: 'SQL',         icon: 'fa-solid fa-database' },
];

let codeBenchRuns = [];
let codeBenchEventSource = null;
let codeBenchDebug = false;
let hallucDebug = false;
let codeBenchTimerInterval = null;
let codeBenchTimerStart = 0;
let hallucTimerInterval = null;
let hallucTimerStart = 0;

function startBenchTimer(type) {
  const wrapperId = type === 'code' ? 'code-bench-timer' : 'halluc-timer';
  const displayId = type === 'code' ? 'code-bench-timer-display' : 'halluc-timer-display';
  const wrapper = document.getElementById(wrapperId);
  const display = document.getElementById(displayId);
  if (!wrapper || !display) return;

  if (type === 'code') {
    if (codeBenchTimerInterval) clearInterval(codeBenchTimerInterval);
    codeBenchTimerStart = Date.now();
    codeBenchTimerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - codeBenchTimerStart) / 1000);
      const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const ss = String(elapsed % 60).padStart(2, '0');
      display.textContent = `${mm}:${ss}`;
    }, 1000);
  } else {
    if (hallucTimerInterval) clearInterval(hallucTimerInterval);
    hallucTimerStart = Date.now();
    hallucTimerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - hallucTimerStart) / 1000);
      const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const ss = String(elapsed % 60).padStart(2, '0');
      display.textContent = `${mm}:${ss}`;
    }, 1000);
  }

  display.textContent = '00:00';
  wrapper.classList.remove('hidden');
}

function stopBenchTimer(type) {
  const wrapperId = type === 'code' ? 'code-bench-timer' : 'halluc-timer';
  const wrapper = document.getElementById(wrapperId);
  if (type === 'code') {
    if (codeBenchTimerInterval) { clearInterval(codeBenchTimerInterval); codeBenchTimerInterval = null; }
  } else {
    if (hallucTimerInterval) { clearInterval(hallucTimerInterval); hallucTimerInterval = null; }
  }
  if (wrapper) wrapper.classList.add('hidden');
}

function toggleBenchDebug(type) {
  if (type === 'code') {
    const cb = document.getElementById('code-debug-cb');
    codeBenchDebug = cb ? cb.checked : !codeBenchDebug;
    showToast('Code debug logging ' + (codeBenchDebug ? 'ON' : 'OFF'), codeBenchDebug ? 'warning' : 'info');
  } else {
    const cb = document.getElementById('halluc-debug-cb');
    hallucDebug = cb ? cb.checked : !hallucDebug;
    showToast('Hallucination debug logging ' + (hallucDebug ? 'ON' : 'OFF'), hallucDebug ? 'warning' : 'info');
  }
}
let selectedCodeRunId = null;

function initCodeBenchLangGrid() {
  const grid = document.getElementById('code-bench-lang-grid');
  if (!grid || grid.children.length > 0) return;
  grid.innerHTML = CODE_LANGS.map(l => `
    <label class="flex items-center gap-1.5 cursor-pointer group">
      <input type="checkbox" class="code-lang-cb checkbox checkbox-xs checkbox-info" value="${l.lang}" checked>
      <span class="text-[10px] font-mono text-[#d8dee9] group-hover:text-[#88c0d0]">
        <i class="${l.icon} mr-0.5 text-[#88c0d0]"></i>${l.label}
      </span>
    </label>
  `).join('');
}

function toggleAllCodeLangs() {
  const cbs = document.querySelectorAll('.code-lang-cb');
  const anyChecked = [...cbs].some(cb => cb.checked);
  cbs.forEach(cb => { cb.checked = !anyChecked; });
}

function toggleJudgeModelSelect() {
  const cb = document.getElementById('code-judge-different');
  const wrap = document.getElementById('code-judge-model-wrap');
  if (!cb || !wrap) return;
  wrap.classList.toggle('hidden', !cb.checked);
}

async function toggleCodeUntestedFilter() {
  codeUntestedFilter = !codeUntestedFilter;
  const btn = document.getElementById('code-untested-btn');
  if (btn) btn.classList.toggle('bench-type-btn-active', codeUntestedFilter);
  if (codeUntestedFilter) {
    try {
      const r = await fetch('/api/benchmarks/code');
      if (r.ok) codeTestedModels = new Set((await r.json()).map(run => run.model_name));
    } catch { /* silently ignore */ }
  }
  populateCodeBenchModelSelects();
}

async function toggleHalluUntestedFilter() {
  halluUntestedFilter = !halluUntestedFilter;
  const btn = document.getElementById('hallu-untested-btn');
  if (btn) btn.classList.toggle('bench-type-btn-active', halluUntestedFilter);
  if (halluUntestedFilter) {
    try {
      const r = await fetch('/api/benchmarks/hallucination');
      if (r.ok) halluTestedModels = new Set((await r.json()).map(run => run.model_name));
    } catch { /* silently ignore */ }
  }
  populateCodeBenchModelSelects();
}

// Build a single <option> string with param-size badge text so the
// makeSearchableSelect widget can parse and display size + ctx badges.
function _benchModelOption(name) {
  const m = models.find(x => x.name === name);
  const p = (m?.details?.parameter_size) || '?';
  return `<option value="${escapeHTML(name)}">${escapeHTML(name)} (${p})</option>`;
}

function _setSelectOptions(el, names, emptyMsg) {
  if (!el) return;
  const cur = el.value;
  el.innerHTML = names.length
    ? names.map(_benchModelOption).join('')
    : `<option value="">${emptyMsg}</option>`;
  if (cur && names.includes(cur)) el.value = cur;
  if (el._ssWidget) el._ssWidget.refresh();
}

function populateCodeBenchModelSelects() {
  const modelNames = models.map(m => m.name);

  // code-bench-model: honour untested filter
  const filteredCode = (codeUntestedFilter && codeTestedModels.size > 0)
    ? modelNames.filter(n => !codeTestedModels.has(n))
    : modelNames;
  _setSelectOptions(
    document.getElementById('code-bench-model'),
    filteredCode,
    '— No untested models found —'
  );

  // code-judge-model-select: no untested filter
  _setSelectOptions(
    document.getElementById('code-judge-model-select'),
    modelNames,
    'No models available'
  );

  // halluc-model: honour untested filter
  const filteredHallu = (halluUntestedFilter && halluTestedModels.size > 0)
    ? modelNames.filter(n => !halluTestedModels.has(n))
    : modelNames;
  _setSelectOptions(
    document.getElementById('halluc-model'),
    filteredHallu,
    '— No untested models found —'
  );
}

function startCodeBenchmark() {
  const model = document.getElementById('code-bench-model')?.value;
  if (!model) { showToast('Select a model first', 'warning'); return; }

  const langs = [...document.querySelectorAll('.code-lang-cb:checked')].map(cb => cb.value);
  if (langs.length === 0) { showToast('Select at least one language', 'warning'); return; }

  const diffJudge = document.getElementById('code-judge-different')?.checked;
  const judgeModel = diffJudge ? (document.getElementById('code-judge-model-select')?.value || 'same') : 'same';

  if (codeBenchEventSource) { codeBenchEventSource.close(); codeBenchEventSource = null; }

  const consoleEl = document.getElementById('code-bench-console');
  if (consoleEl) {
    consoleEl.innerHTML = '';
    consoleEl.closest('.tech-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  const btn = document.getElementById('code-bench-run-btn');
  const stopBtn = document.getElementById('code-bench-stop-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-[10px]"></i> RUNNING…'; }
  if (stopBtn) stopBtn.classList.remove('hidden');

  appendCodeConsole('Connecting to server…');
  startBenchTimer('code');

  const ctxVal = document.getElementById('code-bench-ctx')?.value || '';
  const params = new URLSearchParams({ model, langs: langs.join(','), judge_model: judgeModel });
  if (ctxVal) params.set('num_ctx', ctxVal);
  if (codeBenchDebug) params.set('debug', 'true');
  codeBenchEventSource = new EventSource(`/api/benchmarks/code/run?${params}`);

  const codeBenchDone = () => {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-play text-[10px]"></i>RUN CODE BENCHMARK'; }
    if (stopBtn) stopBtn.classList.add('hidden');
    stopBenchTimer('code');
  };

  codeBenchEventSource.addEventListener('status', e => {
    appendCodeConsole(e.data);
  });

  codeBenchEventSource.addEventListener('error', e => {
    appendCodeConsole('ERROR: ' + e.data);
    codeBenchDone();
    codeBenchEventSource?.close();
  });

  codeBenchEventSource.addEventListener('done', async e => {
    codeBenchEventSource?.close();
    codeBenchEventSource = null;
    codeBenchDone();
    await fetchCodeBenchRuns();
    fetchModelBenchSummary(); // refresh inventory grade badges
    // Refresh untested filter so the just-tested model disappears from the select
    if (codeUntestedFilter) {
      try {
        const r = await fetch('/api/benchmarks/code');
        if (r.ok) codeTestedModels = new Set((await r.json()).map(run => run.model_name));
      } catch { /* ignore */ }
      populateCodeBenchModelSelects();
    }
  });

  codeBenchEventSource.onerror = () => {
    appendCodeConsole('✗ Connection lost — benchmark may have completed or timed out.');
    codeBenchDone();
    codeBenchEventSource?.close();
  };
}

function stopCodeBenchmark() {
  if (codeBenchEventSource) {
    codeBenchEventSource.close();
    codeBenchEventSource = null;
  }
  stopBenchTimer('code');
  appendCodeConsole('⏹ Benchmark stopped by user.');
  const btn = document.getElementById('code-bench-run-btn');
  const stopBtn = document.getElementById('code-bench-stop-btn');
  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-play text-[10px]"></i>RUN CODE BENCHMARK'; }
  if (stopBtn) stopBtn.classList.add('hidden');
}

function copyConsole(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const text = [...el.children].map(d => d.textContent).join('\n');
  if (!text.trim()) { showToast('Console is empty', 'warning'); return; }
  navigator.clipboard.writeText(text)
    .then(() => showToast('Console copied to clipboard', 'success'))
    .catch(() => {
      // Fallback for non-secure contexts
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('Console copied to clipboard', 'success');
    });
}

function consoleLineColor(msg) {
  if (/error|fail|✗/i.test(msg))           return '#bf616a'; // red
  if (/✓|complete|pass|quality:/i.test(msg)) return '#a3be8c'; // green
  if (/⚡|first token/i.test(msg))           return '#ebcb8b'; // amber
  if (/hallucination/i.test(msg))            return '#d08770'; // orange
  return null;
}

function appendCodeConsole(msg) {
  const el = document.getElementById('code-bench-console');
  if (!el) return;
  const div = document.createElement('div');
  div.textContent = msg;
  const color = consoleLineColor(msg);
  if (color) div.style.color = color;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function appendHallucConsole(msg) {
  const el = document.getElementById('halluc-console');
  if (!el) return;
  const div = document.createElement('div');
  div.textContent = msg;
  const color = consoleLineColor(msg);
  if (color) div.style.color = color;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

async function fetchCodeCheckerStatus() {
  const el = document.getElementById('code-checker-status');
  const summary = document.getElementById('code-checker-summary');
  if (!el) return;
  try {
    const res = await fetch('/api/benchmarks/code/checkers');
    if (!res.ok) throw new Error(res.statusText);
    const checkers = await res.json();

    const langMeta = Object.fromEntries(CODE_LANGS.map(l => [l.lang, l]));
    const available = checkers.filter(c => c.available).length;
    const total = checkers.length;
    if (summary) summary.textContent = `${available}/${total} available`;

    el.innerHTML = checkers.map(c => {
      const meta = langMeta[c.lang] || { icon: 'fa-solid fa-code', label: c.lang };
      const dot = c.available
        ? `<span class="text-[#a3be8c]"><i class="fa-solid fa-circle text-[6px]"></i></span>`
        : `<span class="text-[#bf616a]"><i class="fa-solid fa-circle text-[6px]"></i></span>`;
      const binaryLine = c.binary ? `\nTool: ${c.binary}` : '\nTool: built-in';
      const tip = c.available
        ? `${meta.label || c.lang}: checker available${binaryLine}`
        : `${meta.label || c.lang}: not installed${binaryLine}\nInstall: ${c.install_hint || 'not available'}`;
      return `<span title="${escapeHTML(tip)}"
        class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-mono cursor-default
               ${c.available ? 'bg-[#a3be8c]/10 text-[#a3be8c] border border-[#a3be8c]/20' : 'bg-[#bf616a]/10 text-[#bf616a] border border-[#bf616a]/20'}">
        ${dot}<i class="${meta.icon} text-[8px]"></i>${escapeHTML(meta.label || c.lang)}
      </span>`;
    }).join('');
  } catch { /* silently skip if endpoint unavailable */ }
}

async function fetchCodeBenchRuns() {
  try {
    const res = await fetch('/api/benchmarks/code');
    if (!res.ok) throw new Error(res.statusText);
    codeBenchRuns = await res.json();
    renderCodeBenchResults();
    renderLangLeaderboard();
  } catch (e) {
    showToast('Failed to load code benchmark runs: ' + e.message, 'error');
  }
}

const MEDAL = ['🥇','🥈','🥉'];

function renderLangLeaderboard() {
  const panel = document.getElementById('code-lang-leaderboard-panel');
  const el    = document.getElementById('code-lang-leaderboard');
  if (!panel || !el) return;

  // Build top3[lang][node] = [{model, quality_score}, …] sorted desc, max 3
  const top3   = {};
  const nodeSet = new Set();

  const activeLbl = activeServerLabel();
  const langRuns = (lbNodeFilter && activeLbl)
    ? codeBenchRuns.filter(r => r.server_name === activeLbl)
    : codeBenchRuns;

  langRuns.forEach(run => {
    const node = run.server_name || '(local)';
    nodeSet.add(node);
    let langs = [];
    try { langs = JSON.parse(run.extra_json).languages || []; } catch {}
    langs.forEach(l => {
      if (!l.lang) return;
      if (!top3[l.lang]) top3[l.lang] = {};
      if (!top3[l.lang][node]) top3[l.lang][node] = [];
      const arr = top3[l.lang][node];
      const q = l.quality_score || 0;
      // Insert in sorted order, keep top 3 unique models
      if (!arr.find(e => e.model === run.model_name)) {
        arr.push({ model: run.model_name, quality_score: q });
        arr.sort((a, b) => b.quality_score - a.quality_score);
        if (arr.length > 3) arr.pop();
      } else {
        // Update if this run scored higher
        const idx = arr.findIndex(e => e.model === run.model_name);
        if (q > arr[idx].quality_score) {
          arr[idx].quality_score = q;
          arr.sort((a, b) => b.quality_score - a.quality_score);
        }
      }
    });
  });

  if (Object.keys(top3).length === 0) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const nodes = [...nodeSet].sort();

  const badgeCls = q => q >= 8 ? 'bg-[#a3be8c]/20 text-[#a3be8c] border-[#a3be8c]/40'
                       : q >= 6 ? 'bg-[#ebcb8b]/20 text-[#ebcb8b] border-[#ebcb8b]/40'
                       : q >= 4 ? 'bg-[#d08770]/20 text-[#d08770] border-[#d08770]/40'
                       : q > 0  ? 'bg-[#bf616a]/20 text-[#bf616a] border-[#bf616a]/40'
                       :          'bg-[#4c566a]/20 text-[#4c566a] border-[#4c566a]/30';

  // Build icon + label lookup from CODE_LANGS
  const langMeta = Object.fromEntries(CODE_LANGS.map(l => [l.lang, l]));
  const activeLangs = ['python','go','javascript','typescript','node','bash','sh','rust','php','ruby','c','sql']
    .filter(l => top3[l]);

  // One fixed-width cell per medal slot — CSS truncates the model name, title shows full
  const medalCell = (arr, i) => {
    const e = arr?.[i];
    if (!e) return `<div></div>`;
    const q = e.quality_score;
    const bc = badgeCls(q);
    const nm = e.model.replace(/:latest$/, '');
    return `<div class="flex items-center gap-0.5 overflow-hidden">
      <span class="shrink-0 text-[9px]">${MEDAL[i]}</span>
      <span class="shrink-0 inline-flex items-center justify-center px-1 py-px rounded border text-[8px] font-bold font-mono ${bc}" style="min-width:27px">${q.toFixed(1)}</span>
      <span class="text-[8px] font-mono text-[#8fbcbb] overflow-hidden text-ellipsis whitespace-nowrap flex-1" title="${escapeHTML(e.model)}">${escapeHTML(nm)}</span>
    </div>`;
  };

  // Each language row: fixed lang col (70px) + 3 equal medal cols (1fr each)
  const langRow = (lang, node) => {
    const meta = langMeta[lang] || { icon: '', label: lang };
    const arr  = top3[lang]?.[node] || [];
    return `<div style="display:grid;grid-template-columns:70px 1fr 1fr 1fr;gap:0 4px;align-items:center;" class="py-0.5">
      <span class="flex items-center gap-1 text-[9px] font-mono text-[#d8dee9] font-semibold overflow-hidden">
        <i class="${meta.icon} text-[#88c0d0] text-[8px] shrink-0"></i>
        <span class="truncate">${meta.label}</span>
      </span>
      ${medalCell(arr, 0)}${medalCell(arr, 1)}${medalCell(arr, 2)}
    </div>`;
  };

  if (nodes.length === 1) {
    const node = nodes[0];
    // Single-node: 2-col layout, each col is a stack of fixed-width rows
    const half = Math.ceil(activeLangs.length / 2);
    const left  = activeLangs.slice(0, half);
    const right = activeLangs.slice(half);
    el.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 20px;">
        <div>${left.map(l => langRow(l, node)).join('')}</div>
        <div>${right.map(l => langRow(l, node)).join('')}</div>
      </div>`;
  } else {
    // Multi-node: flat CSS grid — lang col + 3 medal cols per node.
    // Flat (no nested grids) so every cell sits in the same grid and columns
    // align perfectly across all rows. Node headers span 3 medal columns each.
    const colTemplate = `70px ${nodes.map(() => '1fr 1fr 1fr').join(' ')}`;
    el.innerHTML = `
      <div style="display:grid;grid-template-columns:${colTemplate};gap:1px 4px;align-items:center;">
        <div></div>
        ${nodes.map(n => `
          <div style="grid-column:span 3" class="text-[8px] font-tech uppercase text-[#88c0d0] tracking-wider pb-1 border-b border-[#4c566a]/30 mb-1">${escapeHTML(n)}</div>
        `).join('')}
        ${activeLangs.map(lang => {
          const meta = langMeta[lang] || { icon: '', label: lang };
          return `
            <span class="flex items-center gap-1 text-[9px] font-mono text-[#d8dee9] font-semibold overflow-hidden py-0.5">
              <i class="${meta.icon} text-[#88c0d0] text-[8px] shrink-0"></i>
              <span class="truncate">${meta.label}</span>
            </span>
            ${nodes.flatMap(node => {
              const arr = top3[lang]?.[node] || [];
              return [0,1,2].map(i => medalCell(arr, i));
            }).join('')}`;
        }).join('')}
      </div>`;
  }
}

function renderHallucLeaderboard() {
  const panel = document.getElementById('halluc-leaderboard-panel');
  const el    = document.getElementById('halluc-leaderboard');
  if (!panel || !el) return;

  if (!hallucinationRuns || hallucinationRuns.length === 0) {
    panel.classList.add('hidden');
    return;
  }

  // Rank by highest context_k where at least one cell has status='recall'.
  // This is the true NIAH metric: "how deep can this model actually find the needle?"
  const byModel = new Map();
  const hallucActiveLbl = activeServerLabel();
  const hallucFiltered = (lbNodeFilter && hallucActiveLbl)
    ? hallucinationRuns.filter(r => r.server_name === hallucActiveLbl)
    : hallucinationRuns;
  hallucFiltered.forEach(r => {
    const key = `${r.model_name}|||${r.server_name || '(local)'}`;
    let cells = [];
    try { cells = JSON.parse(r.extra_json).cells || []; } catch {}
    const maxRecallCtx = cells.reduce((max, c) =>
      c.status === 'recall' && c.context_k > max ? c.context_k : max, 0);
    const cur = byModel.get(key);
    if (!cur || maxRecallCtx > cur.maxRecallCtx ||
        (maxRecallCtx === cur.maxRecallCtx && r.recall_pct > cur.recall_pct)) {
      byModel.set(key, {
        model: r.model_name, node: r.server_name || '(local)',
        maxRecallCtx,
        recall_pct: r.recall_pct, hallucination_pct: r.hallucination_pct,
      });
    }
  });

  const top3h = [...byModel.values()]
    .sort((a, b) => b.maxRecallCtx - a.maxRecallCtx || b.recall_pct - a.recall_pct)
    .slice(0, 3);

  if (top3h.length === 0) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  const fmtK = k => k >= 1024 ? k/1024+'M' : k+'k';
  const recallCls = p => p >= 80 ? 'text-[#a3be8c]' : p >= 50 ? 'text-[#ebcb8b]' : 'text-[#bf616a]';
  const modelShort = m => { const s = m.replace(/:latest$/, ''); return s.length > 18 ? s.slice(0,16)+'…' : s; };

  el.innerHTML = `
    <div class="flex flex-wrap gap-x-6 gap-y-1">
      ${top3h.map((e, i) => `
        <div class="flex items-center gap-2 py-0.5">
          <span class="text-[11px] shrink-0">${MEDAL[i]}</span>
          <span class="font-bold text-[9px] font-mono text-[#88c0d0]">${e.maxRecallCtx > 0 ? fmtK(e.maxRecallCtx) : '—'}</span>
          <span class="text-[8px] font-mono ${recallCls(e.recall_pct)}">${e.recall_pct.toFixed(1)}%</span>
          <span class="text-[8px] font-mono text-[#d8dee9]">${escapeHTML(modelShort(e.model))}</span>
          <span class="text-[8px] font-mono text-[#4c566a]">${escapeHTML(e.node)}</span>
        </div>`).join('')}
    </div>`;
}

function renderCodeBenchResults() {
  const histEl = document.getElementById('code-bench-history');
  if (!histEl) return;

  const langFilter = document.getElementById('code-lang-filter')?.value || '';

  let runs = codeBenchRuns;
  if (langFilter) {
    runs = runs.filter(r => r.languages && r.languages.split(',').includes(langFilter));
  }
  const activeNodeLbl = activeServerLabel();
  if (lbNodeFilter && activeNodeLbl) {
    runs = runs.filter(r => r.server_name === activeNodeLbl);
  }

  if (runs.length === 0) {
    histEl.innerHTML = '<div class="text-center text-[#4c566a] text-xs font-mono py-8">No runs match the current filter.</div>';
    return;
  }

  const scoreColor = s => ({ S: 'text-[#a3be8c]', A: 'text-[#88c0d0]', B: 'text-[#ebcb8b]', C: 'text-[#d08770]', F: 'text-[#bf616a]' }[s] || 'text-[#4c566a]');

  // Group by model_name + server_name, most recent first within each group
  const groups = new Map();
  runs.forEach(r => {
    const key = `${r.model_name}|||${r.server_name || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });
  const groupList = [...groups.values()].map(g => {
    g.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    return g;
  });
  groupList.sort((a, b) => (b[0].created_at || '').localeCompare(a[0].created_at || ''));

  const codeRow = (r, isLatest, gIdx, hasOlder, isOlder = false) => {
    let q = r.avg_quality_score;
    if (langFilter) {
      try {
        const langResult = (JSON.parse(r.extra_json).languages || []).find(l => l.lang === langFilter);
        if (langResult) q = langResult.quality_score || 0;
      } catch { /* ignore */ }
    }
    const langCount = r.languages ? r.languages.split(',').length : 0;
    const chevron = isLatest && hasOlder
      ? `<button onclick="event.stopPropagation(); toggleCodeHistGroup(${gIdx})"
           class="mr-1 text-[#4c566a] hover:text-[#88c0d0] transition-colors">
           <i id="code-grp-icon-${gIdx}" class="fa-solid fa-chevron-right text-[8px]"></i>
         </button>`
      : `<span class="inline-block w-3 mr-1"></span>`;
    const modelCell = isOlder
      ? `<span class="text-[#4c566a] mr-1 select-none">└</span><span class="text-[#8fbcbb]">${escapeHTML(r.model_name)}</span>`
      : `${chevron}<span class="text-[#d8dee9] font-semibold">${escapeHTML(r.model_name)}</span>`;
    const trBase = isOlder
      ? `code-hist-older-${gIdx} hidden bg-[#242933]/50 hover:bg-[#242933]/80`
      : (r.id === selectedCodeRunId ? 'bg-[#3b4252]/40' : 'hover:bg-[#3b4252]/30');
    return `
      <tr class="${trBase} cursor-pointer border-b border-[#4c566a]/10"
          onclick="showCodeBenchDetail(${r.id})">
        <td>${modelCell}</td>
        <td class="text-[#4c566a]">${escapeHTML(r.server_name || '—')}</td>
        <td class="text-[#8fbcbb]">${escapeHTML(r.judge_model)}</td>
        <td class="text-[#d8dee9]">${langCount}</td>
        <td class="text-[#ebcb8b] font-semibold">${q.toFixed(1)}/10</td>
        <td>${r.avg_tps.toFixed(1)}</td>
        <td class="${r.langs_passing_syntax === r.langs_total ? 'text-[#a3be8c]' : 'text-[#bf616a]'}">${r.langs_passing_syntax}/${r.langs_total}</td>
        <td class="font-bold ${scoreColor(r.overall_score)}">${r.overall_score}</td>
        <td class="text-[#4c566a]">${r.created_at ? r.created_at.slice(0, 16) : ''}</td>
        <td><button onclick="event.stopPropagation(); deleteCodeBenchRun(${r.id})" class="btn btn-ghost btn-xs text-[#bf616a] p-1"><i class="fa-solid fa-trash-can text-[9px]"></i></button></td>
      </tr>`;
  };

  let rows = '';
  groupList.forEach((group, gIdx) => {
    const [latest, ...older] = group;
    rows += codeRow(latest, true, gIdx, older.length > 0, false);
    older.forEach(r => { rows += codeRow(r, false, gIdx, false, true); });
  });

  histEl.innerHTML = `
    <table class="table table-xs w-full font-mono text-[10px]">
      <thead>
        <tr class="text-[#4c566a] uppercase text-[9px]">
          <th>Model</th><th>Server</th><th>Judge</th>
          <th>Langs</th><th>Quality</th><th>Avg TPS</th><th>Syntax</th><th>Score</th><th>Date</th><th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function toggleCodeHistGroup(gIdx) {
  const icon = document.getElementById(`code-grp-icon-${gIdx}`);
  const rows = document.querySelectorAll(`.code-hist-older-${gIdx}`);
  if (!rows.length) return;
  const nowHidden = rows[0].classList.toggle('hidden');
  rows.forEach(r => r.classList.toggle('hidden', nowHidden));
  if (icon) icon.className = `fa-solid fa-chevron-${nowHidden ? 'right' : 'down'} text-[8px]`;
}

function showCodeBenchDetail(id) {
  selectedCodeRunId = id;
  renderCodeBenchResults();

  const run = codeBenchRuns.find(r => r.id === id);
  if (!run) return;

  const detailPanel = document.getElementById('code-bench-detail');
  const detailBody = document.getElementById('code-bench-detail-body');
  if (!detailPanel || !detailBody) return;

  let langs = [];
  try {
    const ex = JSON.parse(run.extra_json);
    langs = ex.languages || [];
  } catch { /* ignore */ }

  const langFilter = document.getElementById('code-lang-filter')?.value || '';
  const displayLangs = langFilter ? langs.filter(l => l.lang === langFilter) : langs;

  const scoreBar = (val, max = 10) => {
    const pct = Math.round(val / max * 100);
    const color = val >= 8 ? '#a3be8c' : val >= 6 ? '#ebcb8b' : val >= 4 ? '#d08770' : '#bf616a';
    return `<div class="w-full bg-[#2e3440] rounded-full h-1.5"><div class="h-1.5 rounded-full" style="width:${pct}%;background:${color}"></div></div>`;
  };

  detailBody.innerHTML = `
    <div class="text-[10px] font-mono text-[#4c566a] mb-3">
      Model: <span class="text-[#d8dee9]">${escapeHTML(run.model_name)}</span> |
      Judge: <span class="text-[#8fbcbb]">${escapeHTML(run.judge_model)}</span> |
      Ollama: <span class="text-[#d8dee9]">${escapeHTML(run.ollama_version || '?')}</span> |
      Server: <span class="text-[#d8dee9]">${escapeHTML(run.server_name || '?')}</span>
    </div>
    <div class="space-y-2">
      ${displayLangs.map(l => {
        const j = l.judge || {};
        const syntaxBadge = l.syntax_msg === 'skipped'
          ? '<span class="text-[#4c566a]">—</span>'
          : l.syntax_ok
            ? '<span class="text-[#a3be8c]">✓ PASS</span>'
            : '<span class="text-[#bf616a]">✗ FAIL</span>';
        return `
        <details class="group bg-[#2e3440]/40 border border-[#4c566a]/30 rounded-lg overflow-hidden">
          <summary class="flex items-center justify-between p-2 cursor-pointer hover:bg-[#3b4252]/40 list-none">
            <div class="flex items-center gap-3">
              <span class="text-[#88c0d0] font-semibold text-[10px] w-24">${escapeHTML(l.label || l.lang)}</span>
              <span class="text-[#a3be8c] font-bold">${(l.quality_score || 0).toFixed(1)}/10</span>
              <div class="w-20">${scoreBar(l.quality_score || 0)}</div>
              <span class="text-[#4c566a]">TPS: ${(l.tps || 0).toFixed(1)}</span>
              <span>Syntax: ${syntaxBadge}</span>
            </div>
            <i class="fa-solid fa-chevron-down text-[8px] text-[#4c566a] group-open:rotate-180 transition-transform"></i>
          </summary>
          <div class="p-3 border-t border-[#4c566a]/20 space-y-2">
            <div class="grid grid-cols-3 gap-2 text-[9px] font-mono">
              <div>Correctness: <span class="text-[#ebcb8b]">${(j.correctness || 0).toFixed(1)}</span><br>${scoreBar(j.correctness || 0)}</div>
              <div>Completeness: <span class="text-[#ebcb8b]">${(j.completeness || 0).toFixed(1)}</span><br>${scoreBar(j.completeness || 0)}</div>
              <div>Style: <span class="text-[#ebcb8b]">${(j.style || 0).toFixed(1)}</span><br>${scoreBar(j.style || 0)}</div>
            </div>
            <div class="text-[9px] font-mono text-[#d8dee9] italic">"${escapeHTML(j.brief_critique || '')}"</div>
            ${l.code_snippet ? `<pre class="text-[8px] font-mono text-[#a3be8c] bg-[#1e2330] rounded p-2 overflow-x-auto max-h-40 whitespace-pre-wrap">${escapeHTML(l.code_snippet)}</pre>` : ''}
          </div>
        </details>`;
      }).join('')}
    </div>
  `;

  detailPanel.classList.remove('hidden');
}

async function deleteCodeBenchRun(id) {
  if (!await showConfirm('Delete this code benchmark run?')) return;
  try {
    const res = await fetch(`/api/benchmarks/code/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error);
    if (selectedCodeRunId === id) {
      selectedCodeRunId = null;
      document.getElementById('code-bench-detail')?.classList.add('hidden');
    }
    await fetchCodeBenchRuns();
    showToast('Run deleted', 'success');
  } catch (e) {
    showToast('Delete failed: ' + e.message, 'error');
  }
}

// ── Hallucination Benchmark ───────────────────────────────────────────────────

let hallucinationRuns = [];
let hallucinationEventSource = null;
let liveHeatmapCells = {};

function startHallucinationTest() {
  const model = document.getElementById('halluc-model')?.value;
  if (!model) { showToast('Select a model first', 'warning'); return; }
  const maxK = parseInt(document.getElementById('halluc-max-context')?.value || '32');
  const customFiller = document.getElementById('halluc-custom-filler')?.value?.trim() || '';

  if (hallucinationEventSource) { hallucinationEventSource.close(); hallucinationEventSource = null; }

  liveHeatmapCells = {};
  const consoleEl = document.getElementById('halluc-console');
  if (consoleEl) {
    consoleEl.innerHTML = '';
    consoleEl.closest('.tech-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  const heatmapPanel = document.getElementById('halluc-heatmap-panel');
  if (heatmapPanel) heatmapPanel.classList.remove('hidden');
  renderLiveHeatmap(maxK);

  const btn = document.getElementById('halluc-run-btn');
  const stopBtn = document.getElementById('halluc-stop-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-[10px]"></i> RUNNING…'; }
  if (stopBtn) stopBtn.classList.remove('hidden');

  appendHallucConsole('Connecting to server…');
  startBenchTimer('halluc');

  const params = new URLSearchParams({ model, max_context_k: maxK });
  if (customFiller) params.set('custom_filler', customFiller);
  if (hallucDebug) params.set('debug', 'true');

  hallucinationEventSource = new EventSource(`/api/benchmarks/hallucination/run?${params}`);

  const hallucDone = () => {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-play text-[10px]"></i>RUN HALLUCINATION TEST'; }
    if (stopBtn) stopBtn.classList.add('hidden');
    stopBenchTimer('halluc');
  };

  hallucinationEventSource.addEventListener('status', e => {
    appendHallucConsole(e.data);
  });

  hallucinationEventSource.addEventListener('cell', e => {
    try {
      const cell = JSON.parse(e.data);
      const key = `${cell.context_k}_${cell.position_pct}`;
      liveHeatmapCells[key] = cell;
      updateHeatmapCell(cell);
    } catch { /* ignore */ }
  });

  hallucinationEventSource.addEventListener('error', e => {
    appendHallucConsole('ERROR: ' + e.data);
    hallucDone();
    hallucinationEventSource?.close();
  });

  hallucinationEventSource.addEventListener('done', async e => {
    hallucinationEventSource?.close();
    hallucinationEventSource = null;
    hallucDone();
    try {
      const d = JSON.parse(e.data);
      const statsEl = document.getElementById('halluc-stats');
      if (statsEl) {
        statsEl.innerHTML = `
          <span class="text-[#a3be8c]">Recall: ${(d.recall_pct || 0).toFixed(1)}%</span>
          <span class="text-[#bf616a]">Hallucinations: ${(d.hallucination_pct || 0).toFixed(1)}%</span>
          <span class="text-[#8fbcbb]">Model: ${escapeHTML(d.model_name || '')}</span>
        `;
      }
    } catch { /* ignore */ }
    await fetchHallucinationRuns();
    fetchModelBenchSummary(); // refresh inventory grade badges
    // Refresh untested filter so the just-tested model disappears from the select
    if (halluUntestedFilter) {
      try {
        const r = await fetch('/api/benchmarks/hallucination');
        if (r.ok) halluTestedModels = new Set((await r.json()).map(run => run.model_name));
      } catch { /* ignore */ }
      populateCodeBenchModelSelects();
    }
  });

  hallucinationEventSource.onerror = () => {
    appendHallucConsole('✗ Connection lost — test may have completed or timed out.');
    hallucDone();
    hallucinationEventSource?.close();
  };
}

function stopHallucinationTest() {
  if (hallucinationEventSource) {
    hallucinationEventSource.close();
    hallucinationEventSource = null;
  }
  stopBenchTimer('halluc');
  appendHallucConsole('⏹ Test stopped by user.');
  const btn = document.getElementById('halluc-run-btn');
  const stopBtn = document.getElementById('halluc-stop-btn');
  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-play text-[10px]"></i>RUN HALLUCINATION TEST'; }
  if (stopBtn) stopBtn.classList.add('hidden');
}

function _halluFmtMs(ms) {
  if (!ms || ms <= 0) return '';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function _halluCellHtml(cell, key) {
  if (!cell) {
    return `<div id="heatmap-cell-${key}" class="halluc-cell halluc-cell-pending" data-tip="Pending">·</div>`;
  }
  const cls  = cell.pass ? 'halluc-cell-pass' : cell.is_hallucination ? 'halluc-cell-halluc' : 'halluc-cell-refusal';
  const sym  = cell.pass ? '✓' : cell.is_hallucination ? '✗' : '?';
  const time = _halluFmtMs(cell.total_ms);
  const ttft = cell.ttft_ms > 0 ? `TTFT: ${_halluFmtMs(cell.ttft_ms)}` : '';
  const tot  = cell.total_ms > 0 ? `Total: ${_halluFmtMs(cell.total_ms)}` : '';
  const status = cell.pass ? 'PASS' : cell.is_hallucination ? 'HALLUCINATION' : 'REFUSAL';
  const resp = cell.response ? `\n"${cell.response.slice(0, 80)}${cell.response.length > 80 ? '…' : ''}"` : '';
  const tipParts = [status, ttft, tot].filter(Boolean).join(' · ');
  const tip = tipParts + resp;
  const timeHtml = time ? `<span class="halluc-cell-time">${time}</span>` : '';
  return `<div id="heatmap-cell-${key}" class="halluc-cell ${cls}" data-tip="${escapeHTML(tip)}">${sym}${timeHtml}</div>`;
}

function renderLiveHeatmap(maxK) {
  const heatmapEl = document.getElementById('halluc-heatmap');
  if (!heatmapEl) return;

  const allSizes = [8, 16, 32, 64, 128, 256, 512, 1024, 2048, 5120, 10240];
  const sizes = allSizes.filter(s => s <= maxK);
  const positions = [10, 50, 90];
  const formatK = k => k >= 1024 ? `${k/1024}M` : `${k}k`;

  let html = `<table class="w-full text-[9px] font-mono border-collapse">
    <thead><tr>
      <th class="text-[#4c566a] pr-3 text-right pb-1">Context</th>
      ${positions.map(p => `<th class="text-[#4c566a] text-center pb-1 px-2">Pos ${p}%</th>`).join('')}
    </tr></thead>
    <tbody>
      ${sizes.map(k => `
        <tr>
          <td class="text-[#88c0d0] pr-3 text-right py-1 whitespace-nowrap">${formatK(k)}</td>
          ${positions.map(p => {
            const key = `${k}_${p}`;
            return `<td class="px-2 py-1 text-center">${_halluCellHtml(liveHeatmapCells[key], key)}</td>`;
          }).join('')}
        </tr>`).join('')}
    </tbody>
  </table>`;
  heatmapEl.innerHTML = html;
}

function updateHeatmapCell(cell) {
  const key = `${cell.context_k}_${cell.position_pct}`;
  const el = document.getElementById(`heatmap-cell-${key}`);
  if (!el) return;
  el.outerHTML = _halluCellHtml(cell, key);
}

async function fetchHallucinationRuns() {
  try {
    const res = await fetch('/api/benchmarks/hallucination');
    if (!res.ok) throw new Error(res.statusText);
    hallucinationRuns = await res.json();
    renderHallucinationHistory();
    renderHallucLeaderboard();
  } catch (e) {
    showToast('Failed to load hallucination runs: ' + e.message, 'error');
  }
}

function renderHallucinationHistory() {
  const el = document.getElementById('halluc-history');
  if (!el) return;

  if (!hallucinationRuns || hallucinationRuns.length === 0) {
    el.innerHTML = '<div class="text-center text-[#4c566a] text-xs font-mono py-8">No hallucination tests yet.</div>';
    return;
  }

  // Group by model_name + server_name, most recent first within each group
  const hallucHistActiveLbl = activeServerLabel();
  const hallucHistRuns = (lbNodeFilter && hallucHistActiveLbl)
    ? hallucinationRuns.filter(r => r.server_name === hallucHistActiveLbl)
    : hallucinationRuns;
  const groups = new Map();
  hallucHistRuns.forEach(r => {
    const key = `${r.model_name}|||${r.server_name || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });
  const groupList = [...groups.values()].map(g => {
    g.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    return g;
  });
  groupList.sort((a, b) => (b[0].created_at || '').localeCompare(a[0].created_at || ''));

  const fmtK = k => k >= 1024 ? k / 1024 + 'M' : k + 'k';
  const recallCls = p => p >= 80 ? 'text-[#a3be8c]' : p >= 50 ? 'text-[#ebcb8b]' : 'text-[#bf616a]';
  const hallucCls = p => p > 30 ? 'text-[#bf616a]' : p > 10 ? 'text-[#d08770]' : 'text-[#a3be8c]';

  const hallucRow = (r, isLatest, gIdx, hasOlder, isOlder = false) => {
    const chevron = isLatest && hasOlder
      ? `<button onclick="event.stopPropagation(); toggleHallucHistGroup(${gIdx})"
           class="mr-1 text-[#4c566a] hover:text-[#88c0d0] transition-colors">
           <i id="halluc-grp-icon-${gIdx}" class="fa-solid fa-chevron-right text-[8px]"></i>
         </button>`
      : `<span class="inline-block w-3 mr-1"></span>`;
    const modelCell = isOlder
      ? `<span class="text-[#4c566a] mr-1 select-none">└</span><span class="text-[#8fbcbb]">${escapeHTML(r.model_name)}</span>`
      : `${chevron}<span class="text-[#d8dee9] font-semibold">${escapeHTML(r.model_name)}</span>`;
    const trBase = isOlder
      ? `halluc-hist-older-${gIdx} hidden bg-[#242933]/50 hover:bg-[#242933]/80`
      : 'hover:bg-[#3b4252]/30';
    return `
      <tr class="${trBase} cursor-pointer border-b border-[#4c566a]/10"
          onclick="showHallucinationDetail(${r.id})">
        <td>${modelCell}</td>
        <td class="text-[#4c566a]">${escapeHTML(r.server_name || '—')}</td>
        <td class="text-[#88c0d0]">${fmtK(r.max_context_k)}</td>
        <td class="font-bold ${recallCls(r.recall_pct)}">${r.recall_pct.toFixed(1)}%</td>
        <td class="${hallucCls(r.hallucination_pct)}">${r.hallucination_pct.toFixed(1)}%</td>
        <td class="text-[#4c566a]">${escapeHTML(r.filler_source)}</td>
        <td class="text-[#4c566a]">${r.created_at ? r.created_at.slice(0, 16) : ''}</td>
        <td><button onclick="event.stopPropagation(); deleteHallucinationRun(${r.id})" class="btn btn-ghost btn-xs text-[#bf616a] p-1"><i class="fa-solid fa-trash-can text-[9px]"></i></button></td>
      </tr>`;
  };

  let rows = '';
  groupList.forEach((group, gIdx) => {
    const [latest, ...older] = group;
    rows += hallucRow(latest, true, gIdx, older.length > 0, false);
    older.forEach(r => { rows += hallucRow(r, false, gIdx, false, true); });
  });

  el.innerHTML = `
    <table class="table table-xs w-full font-mono text-[10px]">
      <thead>
        <tr class="text-[#4c566a] uppercase text-[9px]">
          <th>Model</th><th>Server</th><th>Max Ctx</th>
          <th>Recall</th><th>Hallucinations</th><th>Filler</th><th>Date</th><th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function toggleHallucHistGroup(gIdx) {
  const icon = document.getElementById(`halluc-grp-icon-${gIdx}`);
  const rows = document.querySelectorAll(`.halluc-hist-older-${gIdx}`);
  if (!rows.length) return;
  const nowHidden = rows[0].classList.toggle('hidden');
  rows.forEach(r => r.classList.toggle('hidden', nowHidden));
  if (icon) icon.className = `fa-solid fa-chevron-${nowHidden ? 'right' : 'down'} text-[8px]`;
}

function showHallucinationDetail(id) {
  const run = hallucinationRuns.find(r => r.id === id);
  if (!run) return;

  let cells = [];
  let maxK = run.max_context_k;
  try {
    const ex = JSON.parse(run.extra_json);
    cells = ex.cells || [];
  } catch { /* ignore */ }

  liveHeatmapCells = {};
  cells.forEach(cell => {
    liveHeatmapCells[`${cell.context_k}_${cell.position_pct}`] = cell;
  });

  const heatmapPanel = document.getElementById('halluc-heatmap-panel');
  if (heatmapPanel) heatmapPanel.classList.remove('hidden');

  renderLiveHeatmap(maxK);

  const statsEl = document.getElementById('halluc-stats');
  if (statsEl) {
    statsEl.innerHTML = `
      <span class="text-[#a3be8c]">Recall: ${run.recall_pct.toFixed(1)}%</span>
      <span class="text-[#bf616a]">Hallucinations: ${run.hallucination_pct.toFixed(1)}%</span>
      <span class="text-[#4c566a]">Model: ${escapeHTML(run.model_name)}</span>
      <span class="text-[#4c566a]">Ollama: ${escapeHTML(run.ollama_version || '?')}</span>
    `;
  }
}

async function deleteHallucinationRun(id) {
  if (!await showConfirm('Delete this hallucination run?')) return;
  try {
    const res = await fetch(`/api/benchmarks/hallucination/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error);
    await fetchHallucinationRuns();
    showToast('Run deleted', 'success');
  } catch (e) {
    showToast('Delete failed: ' + e.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEUROWIZARD — Guided Model Operations
// ═══════════════════════════════════════════════════════════════════════════════

// Per-wizard runtime state: { name: newModelName, ctrl: AbortController }
const _wzState = {};

function openWz(id) {
  document.getElementById(`wz-${id}`)?.showModal();
  _wzShowStep(id, 'configure');
}

function closeWz(id) {
  const ctrl = _wzState[id]?.ctrl;
  if (ctrl) { ctrl.abort(); delete _wzState[id].ctrl; }
  const modal = document.getElementById(`wz-${id}`);
  if (modal) modal.close();
  setTimeout(() => _wzShowStep(id, 'configure'), 200);
}

function _wzShowStep(id, step) {
  ['configure', 'creating', 'done'].forEach(s => {
    const el = document.getElementById(`wz-${id}-${s}`);
    if (el) el.classList.toggle('hidden', s !== step);
  });
}

function wzOpenInChat(id) {
  const name = _wzState[id]?.name;
  if (!name) return;
  closeWz(id);
  switchWorkspace('playground');
  setTimeout(() => {
    const sel = document.getElementById('chat-model-select');
    if (sel) {
      sel.value = name;
      if (sel._ssWidget) sel._ssWidget.refresh();
    }
  }, 100);
}

async function _wzLaunch(id, modelfile, newName) {
  if (!modelfile || !newName) { showToast('Fill in all required fields', 'error'); return; }
  _wzState[id] = { name: newName };
  _wzShowStep(id, 'creating');

  const nameSpan = document.getElementById(`wz-${id}-creating-name`);
  if (nameSpan) nameSpan.textContent = `"${newName}"`;

  const logEl = document.getElementById(`wz-${id}-log`);
  if (logEl) logEl.innerHTML = '';

  const ctrl = new AbortController();
  _wzState[id].ctrl = ctrl;

  const appendLog = (text, cls = '') => {
    if (!logEl) return;
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = text;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  };

  const showDone = (html) => {
    const doneMsg = document.getElementById(`wz-${id}-done-msg`);
    if (doneMsg) doneMsg.innerHTML = html;
    _wzShowStep(id, 'done');
  };

  try {
    const res = await fetch('/api/models/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName, modelfile }),
      signal: ctrl.signal,
    });

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.status) appendLog(obj.status);
          if (obj.error) {
            showDone(`<span class="text-[#bf616a]"><i class="fa-solid fa-circle-xmark mr-1.5"></i>Failed: ${escapeHTML(obj.error)}</span>`);
            return;
          }
        } catch { appendLog(line); }
      }
    }

    // Success
    const chatBtn = document.getElementById(`wz-${id}-chat-btn`);
    if (chatBtn) chatBtn.classList.remove('hidden');
    showDone(`<span class="text-[#a3be8c]"><i class="fa-solid fa-circle-check mr-1.5"></i>Created <span class="font-bold text-[#d8dee9]">${escapeHTML(newName)}</span> successfully.</span>`);
    fetchModels();

  } catch (e) {
    if (e.name === 'AbortError') return;
    showDone(`<span class="text-[#bf616a]"><i class="fa-solid fa-circle-xmark mr-1.5"></i>${escapeHTML(e.message)}</span>`);
  }
}

// Populate all wizard model selects from the current models array.
// Called from populateModelDropdowns() so it stays in sync automatically.
function populateWizardSelects() {
  const ids = [
    'wz-ctx-model', 'wz-persona-model', 'wz-sampling-model', 'wz-nothink-model',
    'wz-merge-model-a', 'wz-merge-model-b',
    'wz-nosys-model', 'wz-terse-model', 'wz-code-model', 'wz-deterministic-model',
    'wz-language-model', 'wz-format-model', 'wz-character-model', 'wz-rag-model',
  ];
  const opts = '<option value="">— select model —</option>' +
    models.map(m => `<option value="${escapeHTML(m.name)}">${escapeHTML(m.name)}</option>`).join('');
  ids.forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = opts;
    if (prev && sel.querySelector(`option[value="${CSS.escape(prev)}"]`)) sel.value = prev;
  });
}

// Builder subtab switcher
function switchBuilderSubtab(tab) {
  ['recipe', 'wizards'].forEach(t => {
    document.getElementById(`builder-sub-${t}`)?.classList.toggle('hidden', t !== tab);
    const btn = document.getElementById(`builder-subtab-${t}`);
    if (btn) btn.classList.toggle('bench-subtab-active', t === tab);
  });
  if (tab === 'wizards') populateWizardSelects();
}

// ── Wizard: Expand Context ─────────────────────────────────────────────────
function openWizCtx() { openWz('ctx'); populateWizardSelects(); wzCtxUpdate(); }

function wzCtxModelChange() {
  const model = document.getElementById('wz-ctx-model')?.value || '';
  const size  = parseInt(document.getElementById('wz-ctx-size')?.value || '32768');
  const nameEl = document.getElementById('wz-ctx-name');
  if (nameEl && model) {
    const base = model.replace(/:latest$/, '').replace(/[^a-z0-9._-]/gi, '-');
    const k = size >= 1000000 ? `${Math.round(size / 1000000)}m` : `${Math.round(size / 1024)}k`;
    nameEl.value = `${base}-ctx${k}`;
  }
  wzCtxUpdate();
}

function wzCtxUpdate() {
  const model  = document.getElementById('wz-ctx-model')?.value || '';
  const size   = parseInt(document.getElementById('wz-ctx-size')?.value || '32768');
  const warnEl = document.getElementById('wz-ctx-warn');
  if (warnEl) {
    const trained = model ? (modelCtxLengths[model] || 0) : 0;
    if (trained && size > trained) {
      const msg = `${fmtCtx(size)} exceeds trained context (${fmtCtx(trained)})\nOllama will clamp it`;
      warnEl.title = msg; warnEl.dataset.tip = msg;
      warnEl.classList.remove('hidden');
    } else {
      warnEl.classList.add('hidden');
    }
  }
  const preview = document.getElementById('wz-ctx-preview');
  if (preview) preview.textContent = model ? `FROM ${model}\nPARAMETER num_ctx ${size}\n` : '— select a base model —';
}

// ── Wizard: Custom Persona ─────────────────────────────────────────────────
const _wzPersonaPresets = {
  coding:   'You are an expert software engineer. Provide concise, correct, and well-commented code. Prefer modern idioms and explain your reasoning briefly.',
  tutor:    'You are a patient language tutor. Correct grammatical errors gently, explain rules clearly, and adapt your explanations to the learner\'s level.',
  creative: 'You are a creative writing partner. Generate vivid, original prose with strong narrative voice. Embrace metaphor, subtext, and authentic character voice.',
  research: 'You are a meticulous research assistant. Summarize sources accurately, flag uncertainties, cite when possible, and structure your output clearly.',
  custom:   '',
};

function openWizPersona() {
  openWz('persona');
  populateWizardSelects();
  wzPersonaPresetChange(); // load default preset text
  wzPersonaUpdate();
}

function wzPersonaModelChange() {
  const model  = document.getElementById('wz-persona-model')?.value || '';
  const preset = document.getElementById('wz-persona-preset')?.value || 'coding';
  const nameEl = document.getElementById('wz-persona-name');
  if (nameEl && model) {
    const base   = model.replace(/:latest$/, '').replace(/[^a-z0-9._-]/gi, '-');
    const suffix = preset !== 'custom' ? `-${preset}` : '-persona';
    nameEl.value = `${base}${suffix}`;
  }
  wzPersonaUpdate();
}

function wzPersonaPresetChange() {
  const preset = document.getElementById('wz-persona-preset')?.value || 'coding';
  const sysEl  = document.getElementById('wz-persona-system');
  if (sysEl && preset in _wzPersonaPresets && preset !== 'custom') {
    sysEl.value = _wzPersonaPresets[preset];
  }
  // also re-generate name suffix if model already selected
  const model  = document.getElementById('wz-persona-model')?.value || '';
  const nameEl = document.getElementById('wz-persona-name');
  if (nameEl && model) {
    const base   = model.replace(/:latest$/, '').replace(/[^a-z0-9._-]/gi, '-');
    const suffix = preset !== 'custom' ? `-${preset}` : '-persona';
    nameEl.value = `${base}${suffix}`;
  }
  wzPersonaUpdate();
}

function wzPersonaUpdate() {
  const model  = document.getElementById('wz-persona-model')?.value || '';
  const system = document.getElementById('wz-persona-system')?.value || '';
  const preview = document.getElementById('wz-persona-preview');
  if (preview) {
    const escaped = system.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const short   = escaped.length > 100 ? escaped.slice(0, 100) + '…' : escaped;
    preview.textContent = model ? `FROM ${model}\nSYSTEM "${short}"\n` : '— select a base model —';
  }
}

// ── Wizard: Sampling Profile ──────────────────────────────────────────────
const _wzSamplingProfiles = {
  creative: { label: 'High temperature — diverse, imaginative output',     params: 'PARAMETER temperature 0.9\nPARAMETER top_p 0.95\nPARAMETER top_k 40' },
  balanced: { label: 'Moderate temperature — quality/diversity tradeoff',  params: 'PARAMETER temperature 0.7\nPARAMETER top_p 0.9\nPARAMETER top_k 40' },
  precise:  { label: 'Low temperature — deterministic, factual output',    params: 'PARAMETER temperature 0.1\nPARAMETER top_k 10\nPARAMETER top_p 0.5' },
  fast:     { label: 'Capped output — 512 tokens max, balanced temp',      params: 'PARAMETER temperature 0.5\nPARAMETER num_predict 512' },
};

function openWizSampling() { openWz('sampling'); populateWizardSelects(); wzSamplingUpdate(); }

function wzSamplingModelChange() {
  const model   = document.getElementById('wz-sampling-model')?.value || '';
  const profile = document.getElementById('wz-sampling-profile')?.value || 'balanced';
  const nameEl  = document.getElementById('wz-sampling-name');
  if (nameEl && model) {
    const base = model.replace(/:latest$/, '').replace(/[^a-z0-9._-]/gi, '-');
    nameEl.value = `${base}-${profile}`;
  }
  wzSamplingUpdate();
}

function wzSamplingUpdate() {
  const model   = document.getElementById('wz-sampling-model')?.value || '';
  const profile = document.getElementById('wz-sampling-profile')?.value || 'balanced';
  const nameEl  = document.getElementById('wz-sampling-name');
  // Re-generate name suffix when profile changes (if model is selected)
  if (nameEl && model) {
    const base = model.replace(/:latest$/, '').replace(/[^a-z0-9._-]/gi, '-');
    nameEl.value = `${base}-${profile}`;
  }
  const descEl = document.getElementById('wz-sampling-profile-desc');
  if (descEl) descEl.textContent = _wzSamplingProfiles[profile]?.label || '';
  const p = _wzSamplingProfiles[profile];
  const preview = document.getElementById('wz-sampling-preview');
  if (preview) preview.textContent = model && p ? `FROM ${model}\n${p.params}\n` : '— select a base model —';
}

// ── Wizard: Strip Thinking Tokens ─────────────────────────────────────────
function openWizNoThink() { openWz('nothink'); populateWizardSelects(); wzNoThinkUpdate(); }

function wzNoThinkModelChange() {
  const model  = document.getElementById('wz-nothink-model')?.value || '';
  const nameEl = document.getElementById('wz-nothink-name');
  if (nameEl && model) {
    const base = model.replace(/:latest$/, '').replace(/[^a-z0-9._-]/gi, '-');
    nameEl.value = `${base}-nothink`;
  }
  wzNoThinkUpdate();
}

function wzNoThinkUpdate() {
  const model   = document.getElementById('wz-nothink-model')?.value || '';
  const preview = document.getElementById('wz-nothink-preview');
  if (preview) preview.textContent = model ? `FROM ${model}\nSYSTEM "/no_think"\n` : '— select a base model —';
}

// ── Wizard: Merge Models ──────────────────────────────────────────────────
function openWizMerge() { openWz('merge'); populateWizardSelects(); wzMergeUpdate(); }

function wzMergeUpdate() {
  const modelA  = document.getElementById('wz-merge-model-a')?.value || '';
  const modelB  = document.getElementById('wz-merge-model-b')?.value || '';
  const weight  = document.getElementById('wz-merge-weight')?.value || '0.5';
  const method  = document.getElementById('wz-merge-method')?.value || 'SLERP';
  const valSpan = document.getElementById('wz-merge-weight-val');
  if (valSpan) valSpan.textContent = weight;

  const nameEl = document.getElementById('wz-merge-name');
  if (nameEl && modelA && modelB && modelA !== modelB) {
    const a = modelA.replace(/:latest$/, '').replace(/[^a-z0-9._-]/gi, '-');
    const b = modelB.replace(/:latest$/, '').replace(/[^a-z0-9._-]/gi, '-').split('-')[0];
    nameEl.value = `${a}-${b}-blend`;
  }

  const sameWarn = document.getElementById('wz-merge-same-warn');
  if (sameWarn) sameWarn.classList.toggle('hidden', !(modelA && modelB && modelA === modelB));

  const preview = document.getElementById('wz-merge-preview');
  if (preview) {
    preview.textContent = modelA && modelB
      ? `FROM ${modelA}\n# MERGE_METHOD: ${method}\n# MERGE_MODEL: ${modelB}\n# MERGE_RATIO: ${weight}\n`
      : '— select both models —';
  }
}

// ── Wizard: Remove System Prompt ──────────────────────────────────────────
function openWizNoSys() { openWz('nosys'); populateWizardSelects(); wzNoSysUpdate(); }

function wzNoSysModelChange() {
  const model  = document.getElementById('wz-nosys-model')?.value || '';
  const mode   = document.getElementById('wz-nosys-mode')?.value || 'clear';
  const nameEl = document.getElementById('wz-nosys-name');
  if (nameEl && model) {
    const base = model.replace(/:latest$/, '').replace(/[^a-z0-9._-]/gi, '-');
    nameEl.value = `${base}-nosys`;
  }
  wzNoSysUpdate();
}

function wzNoSysUpdate() {
  const model  = document.getElementById('wz-nosys-model')?.value || '';
  const mode   = document.getElementById('wz-nosys-mode')?.value || 'clear';
  const customWrap = document.getElementById('wz-nosys-custom-wrap');
  if (customWrap) customWrap.classList.toggle('hidden', mode !== 'custom');

  let sysLine = '';
  if (mode === 'neutral') {
    sysLine = '\nSYSTEM "Respond helpfully and accurately to user requests."';
  } else if (mode === 'custom') {
    const txt = document.getElementById('wz-nosys-custom')?.value.trim() || '';
    if (txt) sysLine = `\nSYSTEM "${txt.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  const preview = document.getElementById('wz-nosys-preview');
  if (preview) preview.textContent = model ? `FROM ${model}${sysLine}\n` : '— select a base model —';
}

// ── Wizard: Terse Mode ─────────────────────────────────────────────────────
const _wzTerseVariants = {
  minimal:    { label: 'No greetings, no preamble, direct answers only',
                system: 'Be concise. Skip greetings, preamble, and filler text. Give direct answers only.' },
  ultraterse: { label: 'One sentence per answer unless code is requested',
                system: 'One sentence answers only, unless the user asks for code or a list. No filler words.' },
  technical:  { label: 'Precise technical language, no analogies unless asked',
                system: 'Respond in precise technical language. Avoid analogies and simplifications unless explicitly requested.' },
};

function openWizTerse() { openWz('terse'); populateWizardSelects(); wzTerseUpdate(); }

function wzTerseModelChange() {
  const model   = document.getElementById('wz-terse-model')?.value || '';
  const variant = document.getElementById('wz-terse-variant')?.value || 'minimal';
  const nameEl  = document.getElementById('wz-terse-name');
  if (nameEl && model) {
    const base = model.replace(/:latest$/, '').replace(/[^a-z0-9._-]/gi, '-');
    nameEl.value = `${base}-terse`;
  }
  wzTerseUpdate();
}

function wzTerseUpdate() {
  const model   = document.getElementById('wz-terse-model')?.value || '';
  const variant = document.getElementById('wz-terse-variant')?.value || 'minimal';
  const v = _wzTerseVariants[variant];
  const descEl = document.getElementById('wz-terse-desc');
  if (descEl) descEl.textContent = v?.label || '';
  const preview = document.getElementById('wz-terse-preview');
  if (preview) preview.textContent = model && v ? `FROM ${model}\nSYSTEM "${v.system}"\n` : '— select a base model —';
}

// ── Wizard: Code Specialist ───────────────────────────────────────────────
function openWizCode() { openWz('code'); populateWizardSelects(); wzCodeUpdate(); }

function wzCodeModelChange() {
  const model  = document.getElementById('wz-code-model')?.value || '';
  const lang   = document.getElementById('wz-code-lang')?.value || 'any';
  const nameEl = document.getElementById('wz-code-name');
  if (nameEl && model) {
    const base   = model.replace(/:latest$/, '').replace(/[^a-z0-9._-]/gi, '-');
    const suffix = lang === 'any' ? '-coder' : lang === 'custom' ? '-coder' : `-${lang.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    nameEl.value = `${base}${suffix}`;
  }
  wzCodeUpdate();
}

function wzCodeUpdate() {
  const model      = document.getElementById('wz-code-model')?.value || '';
  const langSel    = document.getElementById('wz-code-lang')?.value || 'any';
  const customWrap = document.getElementById('wz-code-custom-wrap');
  if (customWrap) customWrap.classList.toggle('hidden', langSel !== 'custom');

  const lang = langSel === 'custom'
    ? (document.getElementById('wz-code-custom-lang')?.value.trim() || 'the requested language')
    : langSel === 'any' ? 'the requested language' : langSel;

  const system = langSel === 'any'
    ? 'Write only the code requested. No explanations unless asked. No markdown code fences unless asked.'
    : `Write only ${lang} code. No explanations unless asked. No markdown code fences unless asked.`;

  const preview = document.getElementById('wz-code-preview');
  if (preview) {
    preview.textContent = model
      ? `FROM ${model}\nPARAMETER temperature 0.1\nSYSTEM "${system}"\n`
      : '— select a base model —';
  }
}

// ── Wizard: Reproducible Output ───────────────────────────────────────────
function openWizDeterministic() { openWz('deterministic'); populateWizardSelects(); wzDeterministicUpdate(); }

function wzDeterministicModelChange() {
  const model  = document.getElementById('wz-deterministic-model')?.value || '';
  const nameEl = document.getElementById('wz-deterministic-name');
  if (nameEl && model) {
    const base = model.replace(/:latest$/, '').replace(/[^a-z0-9._-]/gi, '-');
    nameEl.value = `${base}-deterministic`;
  }
  wzDeterministicUpdate();
}

function wzDeterministicUpdate() {
  const model    = document.getElementById('wz-deterministic-model')?.value || '';
  const seed     = document.getElementById('wz-deterministic-seed')?.value || '42';
  const lockTemp = document.getElementById('wz-deterministic-locktemp')?.checked ?? true;
  const preview  = document.getElementById('wz-deterministic-preview');
  if (preview) {
    let mf = model ? `FROM ${model}\nPARAMETER seed ${seed}\n` : '— select a base model —';
    if (model && lockTemp) mf += 'PARAMETER temperature 0\n';
    preview.textContent = mf;
  }
}

// ── Wizard: Language Lock ─────────────────────────────────────────────────
function openWizLanguage() { openWz('language'); populateWizardSelects(); wzLanguageUpdate(); }

function wzLanguageModelChange() {
  const model  = document.getElementById('wz-language-model')?.value || '';
  const lang   = document.getElementById('wz-language-lang')?.value || 'Spanish';
  const nameEl = document.getElementById('wz-language-name');
  if (nameEl && model) {
    const base   = model.replace(/:latest$/, '').replace(/[^a-z0-9._-]/gi, '-');
    const suffix = lang === 'custom' ? '-lang' : `-${lang.toLowerCase().replace(/[^a-z]/g, '')}`;
    nameEl.value = `${base}${suffix}`;
  }
  wzLanguageUpdate();
}

function wzLanguageUpdate() {
  const model      = document.getElementById('wz-language-model')?.value || '';
  const langSel    = document.getElementById('wz-language-lang')?.value || 'Spanish';
  const customWrap = document.getElementById('wz-language-custom-wrap');
  if (customWrap) customWrap.classList.toggle('hidden', langSel !== 'custom');

  const lang = langSel === 'custom'
    ? (document.getElementById('wz-language-custom')?.value.trim() || 'the target language')
    : langSel;

  const system = `Always respond in ${lang}, regardless of the language used by the user. Never switch to another language.`;
  const preview = document.getElementById('wz-language-preview');
  if (preview) preview.textContent = model ? `FROM ${model}\nSYSTEM "${system}"\n` : '— select a base model —';
}

// ── Wizard: Format Specialist ─────────────────────────────────────────────
const _wzFormatPresets = {
  markdown:  { label: 'Use clean Markdown for all responses — headers, bold, code blocks, lists',
               system: 'Format all responses using clean Markdown. Use headers, bold, code blocks, and lists where appropriate.' },
  plaintext: { label: 'Plain text only — no Markdown, no headers, no formatting',
               system: 'Respond in plain text only. Do not use Markdown, headers, bold, italics, or any other formatting.' },
  json:      { label: 'JSON objects only — no prose, no explanation',
               system: 'Respond only with valid JSON objects. No prose, no explanation, no markdown. The entire response must be parseable JSON.' },
  bullets:   { label: 'All responses structured as bullet point lists',
               system: 'Structure all responses as concise bullet point lists. Use sub-bullets for hierarchy. Avoid prose paragraphs.' },
  academic:  { label: 'Formal academic writing style with citations and structure',
               system: 'Use formal academic writing style. Structure responses with clear arguments, cite claims where possible, and avoid colloquial language.' },
  socratic:  { label: 'Socratic method — answer questions with guiding questions',
               system: 'Use the Socratic method. When answering questions, guide the user toward the answer with probing questions rather than stating answers directly.' },
  devils:    { label: "Devil's Advocate — always argue the opposing position",
               system: "Play devil's advocate. Always argue the opposite or least obvious position to provoke critical thinking. Clearly note you are doing so." },
};

function openWizFormat() { openWz('format'); populateWizardSelects(); wzFormatUpdate(); }

function wzFormatModelChange() {
  const model   = document.getElementById('wz-format-model')?.value || '';
  const preset  = document.getElementById('wz-format-preset')?.value || 'markdown';
  const nameEl  = document.getElementById('wz-format-name');
  if (nameEl && model) {
    const base = model.replace(/:latest$/, '').replace(/[^a-z0-9._-]/gi, '-');
    nameEl.value = `${base}-${preset}`;
  }
  wzFormatUpdate();
}

function wzFormatUpdate() {
  const model   = document.getElementById('wz-format-model')?.value || '';
  const preset  = document.getElementById('wz-format-preset')?.value || 'markdown';
  const nameEl  = document.getElementById('wz-format-name');
  if (nameEl && model) {
    const base = model.replace(/:latest$/, '').replace(/[^a-z0-9._-]/gi, '-');
    nameEl.value = `${base}-${preset}`;
  }
  const p = _wzFormatPresets[preset];
  const descEl = document.getElementById('wz-format-desc');
  if (descEl) descEl.textContent = p?.label || '';
  const preview = document.getElementById('wz-format-preview');
  if (preview) preview.textContent = model && p ? `FROM ${model}\nSYSTEM "${p.system}"\n` : '— select a base model —';
}

// ── Wizard: Character Creator ─────────────────────────────────────────────
const _wzCharStyles = {
  casual:     'a casual, friendly manner',
  formal:     'a formal, professional manner',
  archaic:    'an archaic, medieval manner using thee/thou and period-appropriate speech',
  futuristic: 'a futuristic, sci-fi manner with technical jargon and forward-looking perspective',
  childlike:  'a simple, childlike manner using easy words and short sentences',
  sarcastic:  'a sarcastic, dry manner with understated wit',
  poetic:     'a poetic, lyrical manner rich in metaphor and imagery',
};

function openWizCharacter() { openWz('character'); populateWizardSelects(); wzCharacterUpdate(); }

function wzCharacterModelChange() {
  const model    = document.getElementById('wz-character-model')?.value || '';
  const charName = document.getElementById('wz-character-charname')?.value.trim() || '';
  const nameEl   = document.getElementById('wz-character-name');
  if (nameEl && model) {
    const base    = model.replace(/:latest$/, '').replace(/[^a-z0-9._-]/gi, '-');
    const chrSlug = charName ? charName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 20) : 'character';
    nameEl.value  = `${base}-${chrSlug}`;
  }
  wzCharacterUpdate();
}

function wzCharacterUpdate() {
  const model       = document.getElementById('wz-character-model')?.value || '';
  const charName    = document.getElementById('wz-character-charname')?.value.trim() || '';
  const personality = document.getElementById('wz-character-personality')?.value.trim() || '';
  const style       = document.getElementById('wz-character-style')?.value || 'casual';
  const styleDesc   = _wzCharStyles[style] || style;

  // Auto-update model name slug when char name changes
  const nameEl = document.getElementById('wz-character-name');
  if (nameEl && model && charName) {
    const base    = model.replace(/:latest$/, '').replace(/[^a-z0-9._-]/gi, '-');
    const chrSlug = charName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 20);
    nameEl.value  = `${base}-${chrSlug}`;
  }

  let system = '';
  if (charName) system += `You are ${charName}. `;
  if (personality) system += `${personality} `;
  system += `Speak in ${styleDesc}. Never break character.`;

  const preview = document.getElementById('wz-character-preview');
  if (preview) {
    const esc   = system.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const short = esc.length > 120 ? esc.slice(0, 120) + '…' : esc;
    preview.textContent = model ? `FROM ${model}\nSYSTEM "${short}"\n` : '— select a base model —';
  }
}

// ── Wizard: RAG-Optimized ─────────────────────────────────────────────────
const _wzRagPresets = {
  strict:     { label: 'Context only — refuses to answer if not in provided documents',
                system: "Answer only from the provided context. If the answer is not present in the context, say exactly: \"I don't have that information in the provided context.\" Do not use prior knowledge or make assumptions." },
  balanced:   { label: 'Prefer context — supplements with general knowledge when needed',
                system: 'Prefer information from provided context. When context is insufficient, you may supplement with general knowledge, but clearly indicate when you are doing so.' },
  permissive: { label: 'Context + knowledge — combines both for comprehensive answers',
                system: 'Use provided context as your primary source. Combine it with your knowledge to give comprehensive, well-rounded answers.' },
};

function openWizRag() { openWz('rag'); populateWizardSelects(); wzRagUpdate(); }

function wzRagModelChange() {
  const model      = document.getElementById('wz-rag-model')?.value || '';
  const strictness = document.getElementById('wz-rag-strictness')?.value || 'balanced';
  const nameEl     = document.getElementById('wz-rag-name');
  if (nameEl && model) {
    const base = model.replace(/:latest$/, '').replace(/[^a-z0-9._-]/gi, '-');
    nameEl.value = `${base}-rag`;
  }
  wzRagUpdate();
}

function wzRagUpdate() {
  const model      = document.getElementById('wz-rag-model')?.value || '';
  const strictness = document.getElementById('wz-rag-strictness')?.value || 'balanced';
  const p = _wzRagPresets[strictness];
  const descEl = document.getElementById('wz-rag-desc');
  if (descEl) descEl.textContent = p?.label || '';
  const preview = document.getElementById('wz-rag-preview');
  if (preview) {
    const sys = p?.system.replace(/\\/g, '\\\\').replace(/"/g, '\\"') || '';
    preview.textContent = model ? `FROM ${model}\nSYSTEM "${sys}"\n` : '— select a base model —';
  }
}

// ── Shared launch dispatcher ──────────────────────────────────────────────
function launchWz(id) {
  let modelfile = '', newName = '';

  switch (id) {
    case 'ctx': {
      const model = document.getElementById('wz-ctx-model')?.value;
      const size  = document.getElementById('wz-ctx-size')?.value;
      newName     = document.getElementById('wz-ctx-name')?.value.trim();
      if (!model) { showToast('Select a base model', 'error'); return; }
      if (!newName) { showToast('Enter a model name', 'error'); return; }
      modelfile   = `FROM ${model}\nPARAMETER num_ctx ${size}\n`;
      break;
    }
    case 'persona': {
      const model  = document.getElementById('wz-persona-model')?.value;
      const system = document.getElementById('wz-persona-system')?.value.trim();
      newName      = document.getElementById('wz-persona-name')?.value.trim();
      if (!model)  { showToast('Select a base model', 'error'); return; }
      if (!system) { showToast('Enter a SYSTEM prompt', 'error'); return; }
      if (!newName){ showToast('Enter a model name', 'error'); return; }
      modelfile    = `FROM ${model}\nSYSTEM "${system.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`;
      break;
    }
    case 'sampling': {
      const model   = document.getElementById('wz-sampling-model')?.value;
      const profile = document.getElementById('wz-sampling-profile')?.value;
      newName       = document.getElementById('wz-sampling-name')?.value.trim();
      if (!model)  { showToast('Select a base model', 'error'); return; }
      if (!newName){ showToast('Enter a model name', 'error'); return; }
      const p = _wzSamplingProfiles[profile];
      modelfile = p ? `FROM ${model}\n${p.params}\n` : `FROM ${model}\n`;
      break;
    }
    case 'nothink': {
      const model = document.getElementById('wz-nothink-model')?.value;
      newName     = document.getElementById('wz-nothink-name')?.value.trim();
      if (!model)  { showToast('Select a base model', 'error'); return; }
      if (!newName){ showToast('Enter a model name', 'error'); return; }
      modelfile   = `FROM ${model}\nSYSTEM "/no_think"\n`;
      break;
    }
    case 'merge': {
      const modelA = document.getElementById('wz-merge-model-a')?.value;
      const modelB = document.getElementById('wz-merge-model-b')?.value;
      const weight = document.getElementById('wz-merge-weight')?.value || '0.5';
      const method = document.getElementById('wz-merge-method')?.value || 'SLERP';
      newName      = document.getElementById('wz-merge-name')?.value.trim();
      if (!modelA) { showToast('Select Model A', 'error'); return; }
      if (!modelB) { showToast('Select Model B', 'error'); return; }
      if (modelA === modelB) { showToast('Select two different models', 'error'); return; }
      if (!newName){ showToast('Enter a model name', 'error'); return; }
      modelfile = `FROM ${modelA}\n# MERGE_METHOD: ${method}\n# MERGE_MODEL: ${modelB}\n# MERGE_RATIO: ${weight}\n`;
      break;
    }
    case 'nosys': {
      const model  = document.getElementById('wz-nosys-model')?.value;
      const mode   = document.getElementById('wz-nosys-mode')?.value || 'clear';
      newName      = document.getElementById('wz-nosys-name')?.value.trim();
      if (!model)  { showToast('Select a base model', 'error'); return; }
      if (!newName){ showToast('Enter a model name', 'error'); return; }
      let sys = '';
      if (mode === 'neutral') {
        sys = '\nSYSTEM "Respond helpfully and accurately to user requests."';
      } else if (mode === 'custom') {
        const txt = document.getElementById('wz-nosys-custom')?.value.trim() || '';
        if (!txt) { showToast('Enter a custom SYSTEM prompt', 'error'); return; }
        sys = `\nSYSTEM "${txt.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      }
      modelfile = `FROM ${model}${sys}\n`;
      break;
    }
    case 'terse': {
      const model   = document.getElementById('wz-terse-model')?.value;
      const variant = document.getElementById('wz-terse-variant')?.value || 'minimal';
      newName       = document.getElementById('wz-terse-name')?.value.trim();
      if (!model)  { showToast('Select a base model', 'error'); return; }
      if (!newName){ showToast('Enter a model name', 'error'); return; }
      const v = _wzTerseVariants[variant];
      modelfile = `FROM ${model}\nSYSTEM "${v?.system || ''}"\n`;
      break;
    }
    case 'code': {
      const model   = document.getElementById('wz-code-model')?.value;
      const langSel = document.getElementById('wz-code-lang')?.value || 'any';
      newName       = document.getElementById('wz-code-name')?.value.trim();
      if (!model)  { showToast('Select a base model', 'error'); return; }
      if (!newName){ showToast('Enter a model name', 'error'); return; }
      const lang = langSel === 'custom'
        ? (document.getElementById('wz-code-custom-lang')?.value.trim() || '')
        : langSel === 'any' ? '' : langSel;
      if (langSel === 'custom' && !lang) { showToast('Enter a custom language', 'error'); return; }
      const system = lang
        ? `Write only ${lang} code. No explanations unless asked. No markdown code fences unless asked.`
        : 'Write only the code requested. No explanations unless asked. No markdown code fences unless asked.';
      modelfile = `FROM ${model}\nPARAMETER temperature 0.1\nSYSTEM "${system}"\n`;
      break;
    }
    case 'deterministic': {
      const model    = document.getElementById('wz-deterministic-model')?.value;
      const seed     = document.getElementById('wz-deterministic-seed')?.value || '42';
      const lockTemp = document.getElementById('wz-deterministic-locktemp')?.checked ?? true;
      newName        = document.getElementById('wz-deterministic-name')?.value.trim();
      if (!model)  { showToast('Select a base model', 'error'); return; }
      if (!newName){ showToast('Enter a model name', 'error'); return; }
      modelfile = `FROM ${model}\nPARAMETER seed ${seed}\n${lockTemp ? 'PARAMETER temperature 0\n' : ''}`;
      break;
    }
    case 'language': {
      const model   = document.getElementById('wz-language-model')?.value;
      const langSel = document.getElementById('wz-language-lang')?.value || 'Spanish';
      newName       = document.getElementById('wz-language-name')?.value.trim();
      if (!model)  { showToast('Select a base model', 'error'); return; }
      if (!newName){ showToast('Enter a model name', 'error'); return; }
      const lang = langSel === 'custom'
        ? (document.getElementById('wz-language-custom')?.value.trim() || '')
        : langSel;
      if (langSel === 'custom' && !lang) { showToast('Enter a custom language', 'error'); return; }
      modelfile = `FROM ${model}\nSYSTEM "Always respond in ${lang}, regardless of the language used by the user. Never switch to another language."\n`;
      break;
    }
    case 'format': {
      const model  = document.getElementById('wz-format-model')?.value;
      const preset = document.getElementById('wz-format-preset')?.value || 'markdown';
      newName      = document.getElementById('wz-format-name')?.value.trim();
      if (!model)  { showToast('Select a base model', 'error'); return; }
      if (!newName){ showToast('Enter a model name', 'error'); return; }
      const p = _wzFormatPresets[preset];
      modelfile = `FROM ${model}\nSYSTEM "${(p?.system || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`;
      break;
    }
    case 'character': {
      const model       = document.getElementById('wz-character-model')?.value;
      const charName    = document.getElementById('wz-character-charname')?.value.trim();
      const personality = document.getElementById('wz-character-personality')?.value.trim();
      const style       = document.getElementById('wz-character-style')?.value || 'casual';
      newName           = document.getElementById('wz-character-name')?.value.trim();
      if (!model)    { showToast('Select a base model', 'error'); return; }
      if (!charName) { showToast('Enter a character name', 'error'); return; }
      if (!newName)  { showToast('Enter a model name', 'error'); return; }
      const styleDesc = _wzCharStyles[style] || style;
      let system = `You are ${charName}. `;
      if (personality) system += `${personality} `;
      system += `Speak in ${styleDesc}. Never break character.`;
      modelfile = `FROM ${model}\nSYSTEM "${system.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`;
      break;
    }
    case 'rag': {
      const model      = document.getElementById('wz-rag-model')?.value;
      const strictness = document.getElementById('wz-rag-strictness')?.value || 'balanced';
      newName          = document.getElementById('wz-rag-name')?.value.trim();
      if (!model)  { showToast('Select a base model', 'error'); return; }
      if (!newName){ showToast('Enter a model name', 'error'); return; }
      const p = _wzRagPresets[strictness];
      modelfile = `FROM ${model}\nSYSTEM "${(p?.system || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`;
      break;
    }
    default:
      return;
  }

  _wzLaunch(id, modelfile, newName);
}
