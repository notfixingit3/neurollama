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

// Initialization
document.addEventListener('DOMContentLoaded', () => {
  init();
});

async function init() {
  initAccordionRow();
  // Non-blocking: fire and forget — page renders immediately, server cards and
  // status dots fill in once the (now-instant) cache read completes.
  fetchServers();
  // Initialize catalog view (does not need server data)
  renderCatalog();

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
    
    localStorage.setItem('chat-rag-enabled', enabled);
    
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
    
    const savedRagEnabled = localStorage.getItem('chat-rag-enabled') === 'true';
    chatRagEnabledEl.checked = savedRagEnabled;
    
    const savedRagModel = localStorage.getItem('chat-rag-model-select');
    const chatRagSelect = document.getElementById('chat-rag-model-select');
    if (savedRagModel && chatRagSelect) {
      chatRagSelect.value = savedRagModel;
    }
    
    const savedRagTopK = localStorage.getItem('chat-rag-top-k');
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
      localStorage.setItem('chat-rag-model-select', chatRagSelectEl.value);
    });
  }

  const chatRagTopKRange = document.getElementById('chat-rag-top-k');
  if (chatRagTopKRange) {
    chatRagTopKRange.addEventListener('change', () => {
      localStorage.setItem('chat-rag-top-k', chatRagTopKRange.value);
    });
  }

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

  // Start background telemetry stream
  startTelemetrySSE();

  // Tick every 30s to keep "Xs ago" timestamps fresh without extra requests
  setInterval(() => {
    if (servers.length > 0) renderServers();
    updateInventorySyncBadge();
  }, 30000);

  // Restore active workspace
  const savedWorkspace = localStorage.getItem('active-workspace') || 'inventory';
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

  // Toggle buttons
  const tabs = ['inventory', 'playground', 'completion', 'builder', 'memory', 'diagnostics', 'benchmark', 'rag', 'settings', 'fleet'];
  tabs.forEach(t => {
    const btn = document.getElementById(`ws-tab-${t}`);
    const panel = document.getElementById(`ws-panel-${t}`);
    
    if (btn && panel) {
      if (t === workspace) {
        btn.classList.add('tab-active');
        panel.classList.remove('hidden');
      } else {
        btn.classList.remove('tab-active');
        panel.classList.add('hidden');
      }
    }
  });

  activeWorkspace = workspace;
  localStorage.setItem('active-workspace', workspace);

  // Tab specific actions
  if (workspace === 'inventory') {
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
    }
  } else if (workspace === 'memory') {
    fetchActiveModels();
  } else if (workspace === 'settings') {
    fetchSchedulerSettings();
    fetchSchedulerLogs();
  } else if (workspace === 'diagnostics') {
    runDiagnostics();
    renderStreamFailureLog();
  } else if (workspace === 'benchmark') {
    populateModelDropdowns();
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
    if (chatSelect) chatSelect.innerHTML = options;
    if (builderSelect) {
      const currentSelected = builderSelect.value;
      builderSelect.innerHTML = '<option value="">-- Select a base model --</option>' + options;
      if (currentSelected && builderSelect.querySelector(`option[value="${currentSelected}"]`)) {
        builderSelect.value = currentSelected;
      }
    }
    if (benchmarkSelect) populateBenchmarkModelSelect();
    if (optimizerSelect) optimizerSelect.innerHTML = options;
    if (ragSelect) {
      const currentSelected = ragSelect.value;
      ragSelect.innerHTML = options;
      if (currentSelected && ragSelect.querySelector(`option[value="${currentSelected}"]`)) {
        ragSelect.value = currentSelected;
      }
    }
    if (chatRagSelect) {
      const currentSelected = chatRagSelect.value;
      chatRagSelect.innerHTML = options;
      if (currentSelected && chatRagSelect.querySelector(`option[value="${currentSelected}"]`)) {
        chatRagSelect.value = currentSelected;
      }
    }
    if (completionSelect) {
      const currentSelected = completionSelect.value;
      completionSelect.innerHTML = options;
      if (currentSelected && completionSelect.querySelector(`option[value="${currentSelected}"]`)) {
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

function recordStreamFailure(area, message) {
  const failures = JSON.parse(localStorage.getItem('neurollama-stream-failures') || '[]');
  failures.unshift({
    area,
    message: String(message || 'Unknown stream failure'),
    created_at: new Date().toISOString()
  });
  localStorage.setItem('neurollama-stream-failures', JSON.stringify(failures.slice(0, 20)));
  renderStreamFailureLog();
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
    <div class="border border-[#4c566a]/30 bg-[#2e3440]/40 rounded-lg p-2">
      <div class="flex items-center justify-between gap-2 mb-1">
        <span class="text-[#bf616a] font-bold uppercase">${escapeHTML(item.area)}</span>
        <span class="text-[#4c566a]">${new Date(item.created_at).toLocaleTimeString()}</span>
      </div>
      <div class="text-[#d8dee9]/80 break-words">${escapeHTML(item.message)}</div>
    </div>
  `).join('');
}

function clearStreamFailureLog() {
  localStorage.removeItem('neurollama-stream-failures');
  renderStreamFailureLog();
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

function updateActiveServerUI(srv) {
  const srvName = document.getElementById('global-active-server-name');
  const srvLatency = document.getElementById('global-active-server-latency');
  const statusIndicator = document.getElementById('global-active-server-status-indicator');
  const statusText = document.getElementById('global-active-server-status-text');

  if (srv) {
    srvName.textContent = srv.name;
    const isOnline = srv.status === 'online';
    
    if (isOnline) {
      srvLatency.textContent = `${srv.latency} ms`;
      statusIndicator.className = 'h-2.5 w-2.5 rounded-full bg-[#a3be8c] status-glow-online inline-block';
      statusText.textContent = 'ONLINE';
      statusText.className = 'text-xs uppercase text-[#a3be8c] font-semibold font-tech';
    } else {
      srvLatency.textContent = '-- ms';
      statusIndicator.className = 'h-2.5 w-2.5 rounded-full bg-[#bf616a] inline-block';
      statusText.textContent = 'OFFLINE';
      statusText.className = 'text-xs uppercase text-[#bf616a] font-semibold font-tech';
    }
  } else {
    srvName.textContent = '---';
    srvLatency.textContent = '-- ms';
    statusIndicator.className = 'h-2.5 w-2.5 rounded-full bg-[#4c566a] inline-block';
    statusText.textContent = 'NONE';
    statusText.className = 'text-xs uppercase text-[#4c566a] font-semibold font-tech';
  }
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

    if (updatedSrv.status === 'online') {
      await fetchModels();
      populateModelDropdowns();
      if (activeWorkspace === 'memory') fetchActiveModels();
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
          <button id="ws-tab-modelfile" onclick="switchDetailTab('modelfile')" class="detail-tab detail-tab-active">FILE</button>
          <button id="ws-tab-parameters" onclick="switchDetailTab('parameters')" class="detail-tab">PARAMS</button>
          <button id="ws-tab-template" onclick="switchDetailTab('template')" class="detail-tab">TEMPLATE</button>
          <button id="ws-tab-system" onclick="switchDetailTab('system')" class="detail-tab">SYSTEM</button>
          <button id="ws-tab-card" onclick="switchDetailTab('card')" class="detail-tab">CARD</button>
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
    showToast(`Failed to pull model '${modelName}'`, 'error');
    console.error('SSE Error:', e);
    recordStreamFailure('model pull', `Failed to pull ${modelName}`);
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
    const btn = accordionEl.querySelector(`#ws-tab-${t}`);
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
    const btn = document.getElementById(`ws-tab-${t}`);
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
  chatMessages.forEach(msg => {
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
          <div class="chat-header text-[10px] text-[#4c566a] mb-1">${modelName.toUpperCase()}</div>
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
      recordStreamFailure('chat', error.message);
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
      recordStreamFailure('model build', error.message);
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
  { name:'hf.co/bartowski/Llama-3.1-8B-Instruct-GGUF:Q4_K_M',              source:'hf', category:'General',   caps:[],            params:'8B',  ctx:'128K', size:'~5 GB',  desc:"Bartowski's Llama 3.1 8B GGUF — popular well-quantized community build." },
  { name:'hf.co/bartowski/gemma-3-27b-it-GGUF:Q4_K_M',                     source:'hf', category:'Vision',    caps:['vision'],    params:'27B', ctx:'128K', size:'~17 GB', desc:"Gemma 3 27B instruction-tuned GGUF with full vision support." },
  { name:'hf.co/bartowski/DeepSeek-R1-Distill-Qwen-14B-GGUF:Q4_K_M',       source:'hf', category:'Reasoning', caps:['reasoning'], params:'14B', ctx:'64K',  size:'~9 GB',  desc:"DeepSeek R1 14B distilled into Qwen — fast reasoning at smaller scale." },
  { name:'hf.co/bartowski/Mistral-Small-3.1-24B-Instruct-2503-GGUF:Q4_K_M',source:'hf', category:'Vision',    caps:['vision'],    params:'24B', ctx:'128K', size:'~15 GB', desc:"Mistral Small 3.1 24B — strong multilingual vision + text model." },
  { name:'hf.co/bartowski/Qwen2.5-Coder-32B-Instruct-GGUF:Q4_K_M',         source:'hf', category:'Code',      caps:['code'],      params:'32B', ctx:'128K', size:'~20 GB', desc:"Qwen 2.5 Coder 32B GGUF — best open-source coding model at this weight." },
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
      ? 'e.g. hf.co/bartowski/Llama-3.1-8B-Instruct-GGUF:Q4_K_M'
      : 'e.g. llama3:8b, mistral, qwen2.5:1.5b';
    input.value = '';
  }
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
  // Switch source toggle to match the model's origin
  if (source && source !== currentPullSource) {
    setPullSource(source);
  }

  const pullInput = document.getElementById('pull-model-name');
  if (!pullInput) return;

  pullInput.value = name;
  pullInput.scrollIntoView({ behavior: 'smooth' });

  const form = document.getElementById('pull-model-form');
  if (form) {
    form.classList.add('border-[#88c0d0]');
    setTimeout(() => form.classList.remove('border-[#88c0d0]'), 800);
    form.dispatchEvent(new Event('submit'));
  }
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
    localStorage.setItem('sidebar-registry-collapsed', 'false');
  } else {
    sidebar.classList.add('hidden');
    mainSection.classList.replace('lg:col-span-9', 'lg:col-span-12');
    if (icon) icon.className = 'fa-solid fa-chevron-right text-xs';
    localStorage.setItem('sidebar-registry-collapsed', 'true');
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
      localStorage.setItem('sidebar-chats-collapsed', 'false');
    } else {
      chatsSidebar.classList.add('hidden');
      localStorage.setItem('sidebar-chats-collapsed', 'true');
    }
  } else if (type === 'config') {
    const isHidden = configSidebar.classList.contains('hidden');
    if (isHidden) {
      configSidebar.classList.remove('hidden');
      localStorage.setItem('sidebar-config-collapsed', 'false');
    } else {
      configSidebar.classList.add('hidden');
      localStorage.setItem('sidebar-config-collapsed', 'true');
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
  const registryCollapsed = localStorage.getItem('sidebar-registry-collapsed') === 'true';
  const chatsCollapsed = localStorage.getItem('sidebar-chats-collapsed') === 'true';
  const configCollapsed = localStorage.getItem('sidebar-config-collapsed') === 'true';

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
      localStorage.setItem(id, el.value);
    }
  });
}

function loadCompletionSettings() {
  completionConfigIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      const saved = localStorage.getItem(id);
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
      recordStreamFailure('completion', err.message);
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

  // Update CPU/RAM bars & labels
  const isRemote = data.ollama_node && data.ollama_node.is_remote;
  const cpuLabel = document.getElementById('host-cpu-label');
  const ramLabel = document.getElementById('host-ram-label');
  if (cpuLabel) {
    cpuLabel.textContent = 'APP CPU:';
  }
  if (ramLabel) {
    ramLabel.textContent = 'APP RAM:';
  }

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

  // Update active models grid and chart if Memory panel is active
  if (activeWorkspace === 'memory') {
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

  function drawLine(key, color, maxVal) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;

    for (let i = 0; i < telemetryHistory.length; i++) {
      const pt = telemetryHistory[i];
      const val = pt[key];
      const x = (width / (MAX_TELEMETRY_POINTS - 1)) * i;
      const y = height - (val / maxVal) * (height - 20) - 10;

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
let currentBenchmarkType = 'standard';
let currentLbFilter = 'all';

const BENCH_TYPES = ['standard', 'vision', 'embedding', 'longctx', 'reasoning'];
const BENCH_TYPE_HINTS = {
  standard:  'Any LLM model — inference speed test',
  vision:    'Requires multimodal model (e.g. llava, gemma3, minicpm-v)',
  embedding: 'Requires embedding model (e.g. nomic-embed-text, mxbai-embed)',
  longctx:   'LLM with large context window recommended (≥8K)',
  reasoning: 'Any LLM — factual accuracy & math test',
};

// Benchmark model select: filtered by capability
function populateBenchmarkModelSelect() {
  const select = document.getElementById('benchmark-model-select');
  if (!select) return;

  let filtered = models;
  if (currentBenchmarkType === 'vision') {
    filtered = models.filter(m => getModelCapabilities(m).includes('vision'));
  } else if (currentBenchmarkType === 'embedding') {
    filtered = models.filter(m => getModelCapabilities(m).includes('embedding'));
  } else {
    // standard / longctx / reasoning — exclude pure embedding models
    filtered = models.filter(m => getModelCapabilities(m).includes('llm'));
  }

  if (filtered.length === 0) {
    select.innerHTML = '<option value="">-- No compatible models found --</option>';
    return;
  }
  select.innerHTML = filtered.map(m => {
    const paramSize = (m.details && m.details.parameter_size) || '?';
    return `<option value="${m.name}">${m.name} (${paramSize})</option>`;
  }).join('');
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
  const filters = ['all', ...BENCH_TYPES];
  filters.forEach(f => {
    const btn = document.getElementById(`lb-filter-${f}`);
    if (btn) btn.classList.toggle('bench-type-btn-active', f === filter);
  });
  fetchBenchmarks();
}

// Leaderboard sort state
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
  if (logContainer) {
    logContainer.innerHTML = `<div class="text-[#88c0d0] uppercase animate-pulse">Initializing ${currentBenchmarkType.toUpperCase()} benchmark for ${model}...</div>`;
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
      div.textContent = e.data;
      logContainer.appendChild(div);
      logContainer.scrollTop = logContainer.scrollHeight;
    }
  });
  
  benchmarkEventSource.addEventListener('error', (e) => {
    if (logContainer) {
      const div = document.createElement('div');
      div.className = 'text-[#bf616a] font-bold mt-1';
      div.textContent = `[ERROR] ${e.data || 'Failed to complete benchmark runs.'}`;
      logContainer.appendChild(div);
      logContainer.scrollTop = logContainer.scrollHeight;
    }
    benchmarkEventSource.close();
    benchmarkEventSource = null;
    setBenchmarkRunning(false);
    recordStreamFailure('benchmark', e.data || 'Failed to complete benchmark runs.');
    showToast('Benchmark run failed', 'error');
  });
  
  benchmarkEventSource.addEventListener('done', (e) => {
    try {
      const res = JSON.parse(e.data);
      if (logContainer) {
        const div = document.createElement('div');
        div.className = 'text-[#a3be8c] font-bold mt-2 border-t border-[#a3be8c]/20 pt-1';
        let extra = {};
        try { extra = JSON.parse(res.extra_json || '{}'); } catch (_) {}
        const bType = res.benchmark_type || 'standard';
        let summary = '';
        if (bType === 'embedding') {
          summary = `Chunks/sec = ${(extra.chunks_per_sec || 0).toFixed(1)}`;
        } else if (bType === 'reasoning') {
          summary = `Accuracy = ${(extra.accuracy_pct || 0).toFixed(0)}%`;
        } else if (bType === 'longctx') {
          summary = `TPS = ${res.tps.toFixed(1)}, Degradation = ${(extra.degradation_pct || 0).toFixed(1)}%`;
        } else {
          summary = `TTFT = ${res.ttft_ms.toFixed(1)}ms, TPS = ${res.tps.toFixed(1)}`;
        }
        div.textContent = `[COMPLETED] ${bType.toUpperCase()} — ${summary}`;
        logContainer.appendChild(div);
        logContainer.scrollTop = logContainer.scrollHeight;
      }
      showToast('Benchmark completed and saved to leaderboard!', 'success');
      fetchBenchmarks();
    } catch (err) {
      console.error(err);
    } finally {
      benchmarkEventSource.close();
      benchmarkEventSource = null;
      setBenchmarkRunning(false);
    }
  });
  
  benchmarkEventSource.onerror = (err) => {
    console.warn('Benchmark EventSource error:', err);
    benchmarkEventSource.close();
    benchmarkEventSource = null;
    setBenchmarkRunning(false);
    recordStreamFailure('benchmark', 'Connection to benchmark stream was interrupted.');
  };
}

function cancelBenchmark() {
  if (!benchmarkEventSource) return;
  benchmarkEventSource.close();
  benchmarkEventSource = null;
  const logContainer = document.getElementById('benchmark-log');
  setBenchmarkRunning(false);
  if (logContainer) {
    const div = document.createElement('div');
    div.className = 'text-[#ebcb8b] font-bold mt-1';
    div.textContent = '[CANCELLED] Benchmark stream stopped by user.';
    logContainer.appendChild(div);
    logContainer.scrollTop = logContainer.scrollHeight;
  }
  showToast('Benchmark run stopped', 'warning');
}

async function fetchBenchmarks() {
  const tbody = document.getElementById('benchmark-leaderboard-body');
  if (!tbody) return;

  try {
    const response = await fetch('/api/benchmarks');
    if (!response.ok) throw new Error('Failed to fetch benchmark leaderboard');
    const list = await response.json();

    // Client-side filter by selected type
    const filtered = (!list || currentLbFilter === 'all')
      ? (list || [])
      : list.filter(b => (b.benchmark_type || 'standard') === currentLbFilter);

    // Client-side sort
    filtered.sort((a, b) => {
      let av, bv;
      switch (lbSortCol) {
        case 'model_name':    av = (a.model_name || '').toLowerCase();    bv = (b.model_name || '').toLowerCase();    break;
        case 'server_name':   av = (a.server_name || '').toLowerCase();   bv = (b.server_name || '').toLowerCase();   break;
        case 'ttft_ms':       av = a.ttft_ms;        bv = b.ttft_ms;       break;
        case 'tps':           av = a.tps;            bv = b.tps;           break;
        case 'avg_latency_ms':av = a.avg_latency_ms; bv = b.avg_latency_ms;break;
        case 'score':         av = SCORE_ORDER[a.reasoning_score] || 0; bv = SCORE_ORDER[b.reasoning_score] || 0; break;
        default:              av = new Date(a.created_at || 0).getTime(); bv = new Date(b.created_at || 0).getTime();
      }
      if (typeof av === 'string') return lbSortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      return lbSortDir === 'asc' ? av - bv : bv - av;
    });

    if (filtered.length === 0) {
      const label = currentLbFilter === 'all' ? '' : ` for type "${currentLbFilter}"`;
      tbody.innerHTML = `
        <tr>
          <td colspan="7" class="text-center py-12 text-[#4c566a] italic">
            No benchmark runs recorded${label}. Select a model on the left to begin.
          </td>
        </tr>
      `;
      return;
    }

    // Type badge colour map (Nord palette)
    const TYPE_BADGE = {
      standard:  { label: 'STD', cls: 'text-[#88c0d0] border-[#88c0d0]' },
      vision:    { label: 'VIS', cls: 'text-[#b48ead] border-[#b48ead]' },
      embedding: { label: 'EMB', cls: 'text-[#ebcb8b] border-[#ebcb8b]' },
      longctx:   { label: 'CTX', cls: 'text-[#a3be8c] border-[#a3be8c]' },
      reasoning: { label: 'RSN', cls: 'text-[#d08770] border-[#d08770]' },
    };

    tbody.innerHTML = filtered.map(b => {
      const bType = b.benchmark_type || 'standard';
      const score = b.reasoning_score || 'F';

      // Type badge
      const tb = TYPE_BADGE[bType] || { label: bType.toUpperCase().slice(0, 3), cls: 'text-[#4c566a] border-[#4c566a]' };
      const typeBadgeHtml = `<span class="border px-1.5 rounded text-[8px] font-bold font-mono ${tb.cls}">${tb.label}</span>`;

      // Speed score badge
      let scoreBadge;
      if      (score === 'S') scoreBadge = 'bg-[#a3be8c]/25 text-[#a3be8c] border-[#a3be8c]';
      else if (score === 'A' || score === 'B') scoreBadge = 'bg-[#88c0d0]/25 text-[#88c0d0] border-[#88c0d0]';
      else if (score === 'C') scoreBadge = 'bg-[#ebcb8b]/25 text-[#ebcb8b] border-[#ebcb8b]';
      else if (score === 'F') scoreBadge = 'bg-[#bf616a]/25 text-[#bf616a] border-[#bf616a]';
      else                   scoreBadge = 'bg-[#4c566a]/25 text-[#d8dee9] border-[#4c566a]';

      // Parse extra_json
      let extra = {};
      try { extra = JSON.parse(b.extra_json || '{}'); } catch (_) {}

      // Server display — prefer name, fall back to hostname from URL
      let serverDisplay = b.server_name || '';
      if (!serverDisplay && b.server_url) {
        try { serverDisplay = new URL(b.server_url).hostname; } catch (_) { serverDisplay = b.server_url; }
      }

      // Type-aware metric cells: TTFT | Metric | Latency
      let ttftCell, metricCell, latCell;
      if (bType === 'embedding') {
        const cps = extra.chunks_per_sec != null ? extra.chunks_per_sec.toFixed(1) : '—';
        ttftCell   = `<td class="text-center text-[#4c566a]">—</td>`;
        metricCell = `<td class="text-center font-bold text-[#ebcb8b]">${cps} <span class="text-[9px] text-[#4c566a] font-normal">ch/s</span></td>`;
        latCell    = `<td class="text-center text-[#4c566a]">—</td>`;
      } else if (bType === 'reasoning') {
        const acc = extra.accuracy_pct != null ? extra.accuracy_pct.toFixed(0) + '%' : '—';
        ttftCell   = `<td class="text-center text-[#4c566a]">—</td>`;
        metricCell = `<td class="text-center font-bold text-[#a3be8c]">${acc} <span class="text-[9px] text-[#4c566a] font-normal">acc</span></td>`;
        latCell    = `<td class="text-center">${b.avg_latency_ms.toFixed(0)} ms</td>`;
      } else if (bType === 'longctx') {
        const deg = extra.degradation_pct != null ? extra.degradation_pct.toFixed(1) + '%' : '';
        const degHtml = deg ? ` <span class="text-[9px] text-[#bf616a] font-normal">↓${deg}</span>` : '';
        ttftCell   = `<td class="text-center">${b.ttft_ms.toFixed(1)} ms</td>`;
        metricCell = `<td class="text-center font-bold text-[#88c0d0]">${b.tps.toFixed(1)}${degHtml}</td>`;
        latCell    = `<td class="text-center">${b.avg_latency_ms.toFixed(0)} ms</td>`;
      } else {
        // standard / vision
        ttftCell   = `<td class="text-center">${b.ttft_ms.toFixed(1)} ms</td>`;
        metricCell = `<td class="text-center font-bold text-[#88c0d0]">${b.tps.toFixed(1)} <span class="text-[9px] text-[#4c566a] font-normal">TPS</span></td>`;
        latCell    = `<td class="text-center">${b.avg_latency_ms.toFixed(0)} ms</td>`;
      }

      const noteHtml = b.notes
        ? `<div class="text-[10px] text-[#4c566a] mt-0.5 max-w-[200px] truncate" title="${escapeHTML(b.notes)}">${escapeHTML(b.notes)}</div>`
        : '';

      return `
        <tr class="hover:bg-[#3b4252]/20 border-b border-[#4c566a]/20 transition-colors">
          <td class="py-3 text-left font-mono">
            <div class="flex items-center gap-1.5 flex-wrap">
              ${typeBadgeHtml}
              <span class="font-bold text-[#e5e9f0]">${escapeHTML(b.model_name)}</span>
            </div>
            ${noteHtml}
          </td>
          <td class="py-3 text-left font-mono text-[11px]">
            <div class="text-[#88c0d0] font-bold">${escapeHTML(serverDisplay || '—')}</div>
            <div class="text-[9px] text-[#4c566a] truncate max-w-[120px]" title="${escapeHTML(b.server_url || '')}">${escapeHTML(b.server_url || '')}</div>
          </td>
          ${ttftCell}
          ${metricCell}
          ${latCell}
          <td class="text-center">
            <span class="border px-2 py-0.5 rounded text-[9px] font-bold ${scoreBadge}">${escapeHTML(score)}</span>
          </td>
          <td class="text-right">
            <div class="flex gap-1 justify-end">
              <button onclick="retestBenchmark('${escapeHTML(b.model_name)}', '${escapeHTML(bType)}')"
                      title="Re-run this benchmark"
                      class="btn btn-xs btn-ghost text-[#88c0d0] hover:bg-[#88c0d0]/15 p-1">
                <i class="fa-solid fa-rotate-right text-[10px]"></i>
              </button>
              <button onclick="openScoreModal(${b.id}, '${escapeHTML(score)}', '${escapeHTML(b.notes || '')}')"
                      class="btn btn-xs btn-neutral border-[#4c566a] font-tech text-[9px] px-2">RATE</button>
              <button onclick="deleteBenchmark(${b.id})" class="btn btn-xs btn-ghost text-[#bf616a] hover:bg-[#bf616a]/15 p-1">
                <i class="fa-solid fa-trash-can text-[10px]"></i>
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
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

// --- HYPERPARAMETER OPTIMIZER CONTROLLERS ---

function switchBenchmarkSubtab(tab) {
  const standardBtn = document.getElementById('benchmark-subtab-standard');
  const optimizerBtn = document.getElementById('benchmark-subtab-optimizer');
  const standardContainer = document.getElementById('benchmark-standard-container');
  const optimizerContainer = document.getElementById('benchmark-optimizer-container');

  const isStandard = tab === 'standard';
  if (standardBtn) standardBtn.classList.toggle('bench-subtab-active', isStandard);
  if (optimizerBtn) optimizerBtn.classList.toggle('bench-subtab-active', !isStandard);
  if (standardContainer) standardContainer.classList.toggle('hidden', !isStandard);
  if (optimizerContainer) optimizerContainer.classList.toggle('hidden', isStandard);

  if (!isStandard) loadOptimizerHistory();
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
    recordStreamFailure('optimizer', e.data || 'Sweep failed or was cancelled.');
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
    recordStreamFailure('optimizer', 'Connection to optimizer stream was interrupted.');
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
  const container = document.getElementById('optimizer-history-container');
  if (!container) return;
  
  try {
    const response = await fetch('/api/optimizer/runs');
    if (!response.ok) throw new Error('Failed to fetch parameter optimizer history');
    const list = await response.json();
    
    // Group runs by Server + Model + Setting (Temp, TopP, TopK)
    const groups = {};
    if (list && list.length > 0) {
      list.forEach(run => {
        // Group Key: Server URL + Model Name + Setting Params
        const key = `${run.server_name || run.server_url}::${run.model_name}::T:${run.temperature}_P:${run.top_p}_K:${run.top_k}`;
        if (!groups[key]) {
          groups[key] = {
            server_name: run.server_name,
            server_url: run.server_url,
            model_name: run.model_name,
            temperature: run.temperature,
            top_p: run.top_p,
            top_k: run.top_k,
            runs: []
          };
        }
        // Retain only the last 3 runs for each unique group
        if (groups[key].runs.length < 3) {
          groups[key].runs.push(run);
        }
      });
    }
    
    let html = '';
    for (let key in groups) {
      const g = groups[key];
      
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
      
      g.runs.forEach(r => {
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
    }
    
    if (html === '') {
      html = `
        <div class="text-center py-12 text-[#4c566a] italic text-xs">
          No past runs logged for the parameter optimizer yet. Run a suite on the left to start history logging.
        </div>
      `;
    }
    
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

// Configure PDF.js worker
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
}

function chunkText(text, size = 800, overlap = 100) {
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (text.length <= size) return [text];
  
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + size;
    if (end > text.length) {
      end = text.length;
    }
    
    if (end < text.length) {
      const maxSearch = Math.min(100, end - start);
      let foundBoundary = false;
      for (let searchIdx = 0; searchIdx < maxSearch; searchIdx++) {
        const char = text.charAt(end - searchIdx);
        if (char === '\n' || char === ' ' || char === '.' || char === '?') {
          end = end - searchIdx + 1;
          foundBoundary = true;
          break;
        }
      }
    }
    
    chunks.push(text.substring(start, end).trim());
    start = end - overlap;
    
    if (start >= end) {
      start = end;
    }
  }
  return chunks.filter(c => c.length > 0);
}

async function handleRAGUpload(file) {
  const modelSelect = document.getElementById('rag-model-select');
  if (!modelSelect || !modelSelect.value) {
    showToast('Please select an embedding model first.', 'warning');
    return;
  }
  const model = modelSelect.value;
  
  const progressDiv = document.getElementById('rag-upload-progress');
  const progressStatus = document.getElementById('rag-progress-status');
  const progressPercent = document.getElementById('rag-progress-percent');
  const progressBar = document.getElementById('rag-progress-bar');
  const uploadLogs = document.getElementById('rag-upload-logs');
  
  if (progressDiv) progressDiv.classList.remove('hidden');
  if (uploadLogs) uploadLogs.innerHTML = '';
  
  const logMessage = (msg, isError = false) => {
    const time = new Date().toLocaleTimeString();
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
  
  try {
    const t0 = Date.now();
    logMessage(`Initializing parse for: ${file.name} (${(file.size / 1024).toFixed(1)} KB)...`);
    updateProgress(10, 'Reading file...');

    let text = '';
    const extension = file.name.split('.').pop().toLowerCase();

    if (extension === 'pdf') {
      if (!window.pdfjsLib) {
        throw new Error('PDF.js library not loaded — check your internet connection and refresh the page.');
      }
      if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
      }
      logMessage('Reading PDF into memory...');
      updateProgress(15, 'Reading PDF...');

      const arrayBuffer = await file.arrayBuffer();
      logMessage('Parsing PDF structure with PDF.js...');
      updateProgress(20, 'Parsing PDF...');

      let pdf;
      try {
        pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      } catch (pdfErr) {
        throw new Error(`PDF.js failed to open file: ${pdfErr.message || pdfErr}`);
      }

      logMessage(`Found ${pdf.numPages} page(s) — extracting text...`);
      if (pdf.numPages > 50) {
        logMessage(`⚠ Large document (${pdf.numPages} pages). This may take a moment.`);
      }

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items.map(item => item.str).join(' ');
        text += pageText + '\n';

        const pct = 20 + Math.round((i / pdf.numPages) * 30);
        if (i % 10 === 0 || i === pdf.numPages) {
          logMessage(`Extracted page ${i}/${pdf.numPages} — ${text.length.toLocaleString()} chars so far`);
        }
        updateProgress(pct, `Parsing PDF (page ${i}/${pdf.numPages})...`);
      }
    } else if (extension === 'txt' || extension === 'md') {
      text = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = (err) => reject(err);
        reader.readAsText(file);
      });
      updateProgress(50, 'Text extracted successfully.');
    } else {
      throw new Error('Unsupported file format. Only .txt, .md, and .pdf files are allowed.');
    }

    if (!text.trim()) {
      throw new Error('No extractable text found in this file. It may be an image-only/scanned PDF — try converting to text first.');
    }

    logMessage(`Extracted ${text.length.toLocaleString()} chars in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    logMessage('Chunking into ~800-char blocks (100-char overlap)...');
    updateProgress(60, 'Chunking text...');

    const chunks = chunkText(text, 800, 100);
    logMessage(`${chunks.length} chunks ready — sending to Ollama for embedding (this may take a moment if the model is cold-loading)...`);

    updateProgress(70, `Embedding ${chunks.length} chunks via ${model}...`);

    const payload = {
      name: file.name,
      embedding_model: model,
      chunks: chunks.map((c, idx) => ({
        chunk_index: idx,
        content: c
      }))
    };

    const response = await fetch('/api/rag/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      let errMsg = `Server error ${response.status}`;
      try {
        const errData = await response.json();
        errMsg = errData.error || errMsg;
      } catch (_) {}
      throw new Error(errMsg);
    }
    
    const resData = await response.json();
    logMessage(`Indexer response: ${resData.message} (ID: ${resData.document_id}, Chunks: ${resData.chunks})`);
    updateProgress(100, 'Indexing complete!');
    showToast(`Successfully indexed "${file.name}" with ${resData.chunks} chunks.`, 'success');
    
    loadRAGDocuments();
    
    const fileInput = document.getElementById('rag-file-input');
    if (fileInput) fileInput.value = '';
    
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
      html += `
        <tr class="hover:bg-[#3b4252]/20 border-b border-[#4c566a]/20 last:border-none transition-colors">
          <td class="py-2.5 pl-0 font-bold text-[#d8dee9] max-w-[200px] truncate" title="${escapeHTML(doc.name)}">
            <i class="fa-regular fa-file-code text-[#88c0d0] mr-1.5"></i>${escapeHTML(doc.name)}
          </td>
          <td class="py-2.5 text-[#4c566a] text-xs font-mono select-all">${escapeHTML(doc.embedding_model)}</td>
          <td class="py-2.5 text-center text-[#88c0d0] font-bold">${doc.chunk_count || 0}</td>
          <td class="py-2.5 text-[#4c566a] text-[10px]">${createdDate}</td>
          <td class="py-2.5 text-center pr-0">
            <button onclick="deleteRAGDocument(${doc.id}, '${escapeHTML(doc.name)}')" class="btn btn-ghost btn-xs text-[#bf616a] hover:bg-[#bf616a]/15 p-1 h-auto min-h-0">
              <i class="fa-solid fa-trash-can text-[10px]"></i>
            </button>
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

async function runRAGSimilarityQuery() {
  const queryInput = document.getElementById('rag-test-query');
  const resultsDiv = document.getElementById('rag-query-results');
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
