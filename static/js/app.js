// State Management
let servers = [];
let models = [];
let selectedModels = new Set();
let inspectedModel = null;
let activeDetailTab = 'modelfile';
let currentEventSource = null;

// New State for v0.0.2
let activeWorkspace = 'inventory';
let chatMessages = [];
let isGeneratingChat = false;
let isBuildingModel = false;

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
  await fetchServers();
  // If we have an active server, fetch its models
  const activeServer = servers.find(s => s.isActive);
  if (activeServer && activeServer.status === 'online') {
    await fetchModels();
  } else {
    updateActiveServerUI(activeServer);
  }
  // Initialize catalog view
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
    'chat-num-thread'
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
    }
  });

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
  const tabs = ['inventory', 'playground', 'completion', 'builder', 'memory', 'benchmark'];
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
  if (workspace === 'memory') {
    fetchActiveModels();
    fetchSchedulerSettings();
    fetchSchedulerLogs();
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
  }
}

function populateModelDropdowns() {
  const chatSelect = document.getElementById('chat-model-select');
  const builderSelect = document.getElementById('builder-base-select');
  const completionSelect = document.getElementById('completion-model-select');
  const benchmarkSelect = document.getElementById('benchmark-model-select');
  const optimizerSelect = document.getElementById('optimizer-model-select');

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
  } else {
    if (chatSelect) chatSelect.innerHTML = options;
    if (builderSelect) builderSelect.innerHTML = options;
    if (benchmarkSelect) benchmarkSelect.innerHTML = options;
    if (optimizerSelect) optimizerSelect.innerHTML = options;
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

// --- SERVER MANAGEMENT ---

async function fetchServers() {
  try {
    const response = await fetch('/api/servers');
    if (!response.ok) throw new Error('Failed to fetch servers');
    servers = await response.json();
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

    return `
      <div class="p-3 border rounded-lg flex flex-col justify-between gap-2 transition-all ${activeBorder} group">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 cursor-pointer flex-1" onclick="selectServer('${srv.id}')">
            ${statusDot}
            <div>
              <h3 class="font-bold text-xs truncate max-w-[130px] text-[#e5e9f0] group-hover:text-[#88c0d0] transition-colors">${srv.name}</h3>
              <p class="text-[9px] font-mono text-[#4c566a] truncate max-w-[130px]">${srv.url}</p>
            </div>
          </div>
          <div class="flex items-center gap-1 opacity-40 group-hover:opacity-100 transition-opacity">
            <button onclick="openEditServerModal('${srv.id}', '${srv.name}', '${srv.url}')" class="btn btn-ghost btn-xs p-1 text-[#88c0d0]" title="Edit Node">
              <i class="fa-solid fa-pen"></i>
            </button>
            <button onclick="deleteServer('${srv.id}')" class="btn btn-ghost btn-xs p-1 text-[#bf616a]" title="Delete Node">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </div>
        </div>
        <div class="flex items-center justify-between text-[9px] font-mono text-[#4c566a]">
          <span>${isOnline ? `Version: ${srv.version}` : 'UNREACHABLE'}</span>
          <span>${isOnline ? `${srv.latency} ms` : ''}</span>
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
    
    await fetchServers();
    
    // Clear selections and inspected model details
    selectedModels.clear();
    document.getElementById('select-all-checkbox').checked = false;
    updateBatchActionsUI();
    clearInspectedModel();
    resetChatSession();
    
    if (updatedSrv.status === 'online') {
      await fetchModels();
      populateModelDropdowns();
      if (activeWorkspace === 'memory') {
        fetchActiveModels();
      }
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
  const name = document.getElementById('add-server-name').value;
  const url = document.getElementById('add-server-url').value;

  try {
    const response = await fetch('/api/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to add server');
    }

    showToast(`Node '${name}' registered successfully`, 'success');
    closeAddServerModal();
    document.getElementById('add-server-form').reset();
    
    await fetchServers();
    // If we only have 1 server now, it became active automatically. Fetch models.
    if (servers.length === 1 && servers[0].status === 'online') {
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
  const name = document.getElementById('edit-server-name').value;
  const url = document.getElementById('edit-server-url').value;

  try {
    const response = await fetch(`/api/servers/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to edit server');
    }

    showToast(`Node '${name}' updated successfully`, 'success');
    closeEditServerModal();
    
    await fetchServers();
    const active = servers.find(s => s.isActive);
    if (active && active.id === id) {
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
    
    await fetchServers();
    
    if (wasActive) {
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
function openAddServerModal() {
  document.getElementById('add-server-modal').showModal();
}
function closeAddServerModal() {
  document.getElementById('add-server-modal').close();
}
function openEditServerModal(id, name, url) {
  document.getElementById('edit-server-id').value = id;
  document.getElementById('edit-server-name').value = name;
  document.getElementById('edit-server-url').value = url;
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
    renderModels();
  } catch (error) {
    console.error(error);
    renderModelsEmpty(error.message);
  }
}

function renderModels() {
  const listBody = document.getElementById('models-list-body');
  
  if (models.length === 0) {
    listBody.innerHTML = `
      <tr>
        <td colspan="5" class="text-center py-8 text-[#4c566a] italic">
          No models found on this server. Pull a model above to begin.
        </td>
      </tr>
    `;
    return;
  }

  listBody.innerHTML = models.map(model => {
    const isChecked = selectedModels.has(model.name);
    const dateFormatted = new Date(model.modified_at).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
    
    const sizeFormatted = formatBytes(model.size);
    const paramSize = (model.details && model.details.parameter_size) || 'N/A';

    return `
      <tr class="hover:bg-[#3b4252]/30 border-b border-[#4c566a]/30 transition-colors">
        <td>
          <input type="checkbox" onchange="toggleSelectModel('${model.name}', this.checked)" ${isChecked ? 'checked' : ''}
                 class="checkbox checkbox-xs checkbox-primary border-[#4c566a]" />
        </td>
        <td>
          <div class="font-bold text-[#e5e9f0] cursor-pointer hover:text-[#88c0d0] transition-colors" onclick="inspectModel('${model.name}')">
            ${model.name}
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
            <button onclick="inspectModel('${model.name}')" class="btn btn-xs btn-neutral border-[#4c566a] text-[10px] font-tech" title="Inspect Telemetry">
              INSPECT
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
  
  // Re-check select all box if necessary
  const allChecked = models.length > 0 && models.every(m => selectedModels.has(m.name));
  document.getElementById('select-all-checkbox').checked = allChecked;

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
  if (checkbox.checked) {
    models.forEach(m => selectedModels.add(m.name));
  } else {
    models.forEach(m => selectedModels.delete(m.name));
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

  const modelName = document.getElementById('pull-model-name').value.trim();
  if (!modelName) return;

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
  const panel = document.getElementById('model-detail-panel');
  const emptyState = document.getElementById('detail-empty-state');
  const content = document.getElementById('detail-content');
  const nameHeader = document.getElementById('detail-model-name');
  const tabContent = document.getElementById('tab-content-text');

  emptyState.classList.add('hidden');
  content.classList.remove('hidden');
  
  tabContent.textContent = 'Retrieving telemetry...';
  
  // Badges
  document.getElementById('badge-format').textContent = '...';
  document.getElementById('badge-family').textContent = '...';
  document.getElementById('badge-quant').textContent = '...';
  document.getElementById('badge-params').textContent = '...';
  document.getElementById('detail-digest').textContent = 'sha256:...';

  try {
    const response = await fetch(`/api/models/detail?name=${encodeURIComponent(name)}`);
    if (!response.ok) throw new Error('Failed to load model details');

    inspectedModel = await response.json();
    inspectedModel.name = name; // attach name

    // Render static data
    nameHeader.textContent = name;
    
    const details = inspectedModel.details || {};
    document.getElementById('badge-format').textContent = (details.format || 'gguf').toUpperCase();
    document.getElementById('badge-family').textContent = (details.family || 'unknown').toLowerCase();
    document.getElementById('badge-quant').textContent = details.quantization_level || 'N/A';
    document.getElementById('badge-params').textContent = details.parameter_size || 'N/A';
    
    // Find digest or model fingerprint if available
    let digest = 'Unknown';
    const activeModelObj = models.find(m => m.name === name);
    if (activeModelObj) {
      digest = activeModelObj.digest.substring(0, 16) + '...';
    }
    document.getElementById('detail-digest').textContent = digest;

    // Render tab content
    renderTabContent();
  } catch (error) {
    console.error(error);
    showToast(error.message, 'error');
    clearInspectedModel();
  }
}

function clearInspectedModel() {
  inspectedModel = null;
  document.getElementById('detail-empty-state').classList.remove('hidden');
  document.getElementById('detail-content').classList.add('hidden');
}

function switchDetailTab(tabName) {
  // Update buttons
  const tabs = ['modelfile', 'parameters', 'template', 'system', 'card'];
  tabs.forEach(t => {
    const btn = document.getElementById(`ws-tab-${t}`);
    if (btn) {
      if (t === tabName) {
        btn.classList.add('tab-active');
      } else {
        btn.classList.remove('tab-active');
      }
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
      html += `
        <div class="chat chat-start animate-fade-in">
          <div class="chat-image avatar">
            <div class="w-8 h-8 rounded-full border border-[#88c0d0] flex items-center justify-center bg-[#2e3440]">
              <i class="fa-solid fa-terminal text-[#88c0d0] text-xs"></i>
            </div>
          </div>
          <div class="chat-header text-[10px] text-[#4c566a] mb-1">${modelName.toUpperCase()}</div>
          <div class="chat-bubble bg-[#242933] border border-[#4c566a]/50 text-[#e5e9f0] leading-relaxed max-w-[85%] whitespace-pre-wrap">${formattedContent}</div>
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
    num_thread: numThread
  };
  if (seedVal) {
    payload.seed = parseInt(seedVal);
  }

  const startTime = performance.now();
  let firstTokenTime = null;
  let tokenCount = 0;

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
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
            }
          } catch (e) {
            console.error('Error parsing SSE line:', e, dataStr);
          }
        }
      }
    }

  } catch (error) {
    console.error('Chat error:', error);
    showToast(error.message, 'error');
    telemetry.textContent = 'CONNECTION FAILED';
    telemetry.className = 'text-[#bf616a]';
    if (chatMessages[assistantMsgIndex].content === '') {
      chatMessages.pop();
      renderChatHistory();
    }
  } finally {
    isGeneratingChat = false;
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

  // Lock UI
  isBuildingModel = true;
  buildBtn.disabled = true;
  buildBtn.innerHTML = `<i class="fa-solid fa-circle-notch animate-spin mr-1"></i> COMPILING...`;
  indicator.className = 'h-2 w-2 rounded-full bg-[#ebcb8b] animate-pulse'; // Amber warning pulse
  
  logBox.innerHTML = `<div class="text-[#88c0d0]">CONNECTING TO COMPILER PIPELINE...</div>`;

  try {
    const response = await fetch('/api/models/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, modelfile })
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
    showToast(error.message, 'error');
    logBox.insertAdjacentHTML('beforeend', `<div class="text-[#bf616a] font-bold mt-2">>> PIPELINE ERROR: ${error.message.toUpperCase()}</div>`);
    indicator.className = 'h-2 w-2 rounded-full bg-[#bf616a]'; // Red static
  } finally {
    isBuildingModel = false;
    buildBtn.disabled = false;
    buildBtn.innerHTML = `<i class="fa-solid fa-cube mr-1"></i> COMPILE_MODEL // BUILD`;
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

const POPULAR_MODELS = [
  { name: 'llama3:8b', category: 'General', size: '4.7 GB', desc: 'Meta\'s highly capable general purpose instruction tuned model.' },
  { name: 'deepseek-r1:8b', category: 'Reasoning', size: '4.9 GB', desc: 'First-class reasoning model from DeepSeek optimized with RL.' },
  { name: 'qwen2.5-coder:7b', category: 'Coding', size: '4.7 GB', desc: 'Alibaba\'s advanced LLM specializing in code generation and reasoning.' },
  { name: 'mistral:7b', category: 'General', size: '4.1 GB', desc: 'High quality 7B parameter dense model by Mistral AI.' },
  { name: 'gemma2:2b', category: 'Lightweight', size: '1.6 GB', desc: 'Google\'s highly efficient lightweight model with top-tier performance.' },
  { name: 'phi3:3.8b', category: 'General', size: '2.2 GB', desc: 'Microsoft\'s lightweight open model with excellent reasoning capabilities.' },
  { name: 'llava:7b', category: 'Multimodal', size: '4.7 GB', desc: 'Multimodal model combining vision encoder and llama language model.' },
  { name: 'codegemma:7b', category: 'Coding', size: '4.8 GB', desc: 'Google\'s specialized model for code completion and code generation.' }
];

function renderCatalog() {
  const grid = document.getElementById('catalog-grid');
  if (!grid) return;

  const filterText = document.getElementById('catalog-filter')?.value.toLowerCase().trim() || '';

  const filtered = POPULAR_MODELS.filter(item => {
    return item.name.toLowerCase().includes(filterText) ||
           item.category.toLowerCase().includes(filterText) ||
           item.desc.toLowerCase().includes(filterText);
  });

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="col-span-full text-center py-6 text-[#4c566a] italic text-xs">
        No matching models found in catalog.
      </div>
    `;
    return;
  }

  grid.innerHTML = filtered.map(item => {
    // Check if installed locally
    const isInstalled = models.some(m => {
      const nameOnlyLocal = m.name.split(':')[0];
      const nameOnlyCatalog = item.name.split(':')[0];
      return m.name === item.name || nameOnlyLocal === nameOnlyCatalog;
    });

    return `
      <div class="p-2.5 border border-[#4c566a]/30 bg-[#242933]/30 rounded-lg flex flex-col justify-between gap-1.5 hover:border-[#4c566a]/60 transition-colors">
        <div class="flex justify-between items-start gap-1">
          <div class="min-w-0">
            <span class="font-bold text-[#e5e9f0] block truncate text-xs" title="${item.name}">${item.name}</span>
            <span class="text-[9px] text-[#4c566a] block truncate">${item.size} // <span class="text-[#81a1c1]">${item.category}</span></span>
          </div>
          <div class="shrink-0">
            ${isInstalled ? 
              `<span class="badge bg-[#a3be8c]/15 border-[#a3be8c]/40 text-[#a3be8c] text-[8px] font-mono px-1.5 py-0.5 rounded font-bold uppercase tracking-wider"><i class="fa-solid fa-check mr-0.5"></i>INSTALLED</span>` : 
              `<button onclick="pullCatalogModel('${item.name}')" class="btn btn-xs btn-outline btn-info font-tech text-[9px] px-2 py-0 h-5 min-h-0 uppercase">PULL</button>`
            }
          </div>
        </div>
        <p class="text-[10px] text-[#4c566a] leading-tight line-clamp-2">${item.desc}</p>
      </div>
    `;
  }).join('');
}

function filterCatalog() {
  renderCatalog();
}

function pullCatalogModel(name) {
  const pullInput = document.getElementById('pull-model-name');
  if (!pullInput) return;

  pullInput.value = name;
  pullInput.scrollIntoView({ behavior: 'smooth' });
  
  // Flash effect on pull form to guide user
  const form = document.getElementById('pull-model-form');
  if (form) {
    form.classList.add('tech-glow-blue');
    setTimeout(() => form.classList.remove('tech-glow-blue'), 1000);
    
    // Submit the form
    form.dispatchEvent(new Event('submit'));
  }
}

function handleHfPull(event) {
  event.preventDefault();
  let tag = document.getElementById('hf-pull-name').value.trim();
  if (!tag) return;

  if (!tag.startsWith('hf.co/')) {
    if (tag.includes('/')) {
      tag = 'hf.co/' + tag;
    } else {
      showToast('Invalid Hugging Face GGUF tag format. Must be user/repo:tag or hf.co/user/repo:tag', 'warning');
      return;
    }
  }

  // Pre-fill main pull form
  const pullInput = document.getElementById('pull-model-name');
  if (pullInput) {
    pullInput.value = tag;
    document.getElementById('hf-pull-name').value = '';
    
    const form = document.getElementById('pull-model-form');
    if (form) {
      form.dispatchEvent(new Event('submit'));
    }
  }
}

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
  const consoleColumn = document.getElementById('playground-console-column');
  const toggleChatsIcon = document.getElementById('toggle-chats-icon');
  const toggleConfigIcon = document.getElementById('toggle-config-icon');

  if (!chatsSidebar || !configSidebar || !consoleColumn) return;

  const chatsHidden = chatsSidebar.classList.contains('hidden');
  const configHidden = configSidebar.classList.contains('hidden');

  // Update icons pointing direction
  if (toggleChatsIcon) {
    toggleChatsIcon.className = chatsHidden ? 'fa-solid fa-chevron-right' : 'fa-solid fa-chevron-left';
  }
  if (toggleConfigIcon) {
    toggleConfigIcon.className = configHidden ? 'fa-solid fa-chevron-right' : 'fa-solid fa-chevron-left';
  }

  // Re-adjust columns classes for the main console grid element
  // First clear any existing lg:col-span class
  consoleColumn.className = consoleColumn.className.replace(/\blg:col-span-\d+\b/, '').trim();

  // Reference string literals to ensure Tailwind compiler registers them
  const c6 = 'lg:col-span-6';
  const c9 = 'lg:col-span-9';
  const c12 = 'lg:col-span-12';

  if (chatsHidden && configHidden) {
    consoleColumn.classList.add(c12);
  } else if (chatsHidden) {
    consoleColumn.classList.add(c9);
  } else if (configHidden) {
    consoleColumn.classList.add(c9);
  } else {
    consoleColumn.classList.add(c6);
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
        <div class="message-body">\${body}</div>
      </div>
    `;
  });

  return \`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Chat Log - \${model}</title>
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
      line-height: 1.6;
      margin: 0;
      padding: 40px 20px;
    }
    
    .container {
      max-width: 800px;
      margin: 0 auto;
    }
    
    header {
      background-color: var(--nord-bg-panel);
      border: 1px solid var(--nord-border);
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 30px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.25);
    }
    
    h1 {
      margin: 0 0 10px 0;
      font-size: 24px;
      color: var(--nord-blue);
      letter-spacing: 0.5px;
    }
    
    .metadata {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 12px;
      margin-top: 15px;
      font-size: 13px;
      color: #81a1c1;
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
      border-radius: 12px;
      padding: 16px 20px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.15);
    }
    
    .message.user {
      border-left: 4px solid var(--nord-blue);
      background-color: var(--nord-bg-hover);
    }
    
    .message.assistant {
      border-left: 4px solid var(--nord-green);
    }
    
    .message.system {
      border-left: 4px solid var(--nord-yellow);
      background-color: var(--nord-bg-panel);
      font-style: italic;
    }
    
    .message-header {
      font-size: 11px;
      font-weight: bold;
      letter-spacing: 1px;
      margin-bottom: 8px;
      color: #88c0d0;
    }
    
    .message.user .message-header {
      color: var(--nord-blue);
    }
    
    .message.assistant .message-header {
      color: var(--nord-green);
    }
    
    .message.system .message-header {
      color: var(--nord-yellow);
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
    
    @media print {
      body {
        background-color: #ffffff;
        color: #000000;
        padding: 0;
      }
      
      .message {
        page-break-inside: avoid;
        box-shadow: none;
        border: 1px solid #cccccc;
        background-color: #ffffff !important;
      }
      
      header {
        box-shadow: none;
        border: 1px solid #cccccc;
        background-color: #f9f9f9 !important;
      }
      
      pre {
        border: 1px solid #cccccc;
        background-color: #f5f5f5 !important;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Chat Session Export</h1>
      <div class="metadata">
        <div class="meta-item"><strong>Model:</strong> \\\${escapeHTML(model)}</div>
        <div class="meta-item"><strong>Date:</strong> \\\${new Date().toLocaleString()}</div>
        <div class="meta-item"><strong>Temp:</strong> \\\${temp}</div>
        <div class="meta-item"><strong>Ctx Limit:</strong> \\\${ctx} tokens</div>
        <div class="meta-item"><strong>Top P:</strong> \\\${topP}</div>
        <div class="meta-item"><strong>Top K:</strong> \\\${topK}</div>
      </div>
    </header>
    
    <div class="messages-list">
      \\\${messageHtml}
    </div>
  </div>
</body>
</html>\`;
}

// --- 3. MODEL CARD FETCHING & PARSING ---
async function fetchModelCard(modelName, container) {
  try {
    const resp = await fetch(`/api/models/card?name=\${encodeURIComponent(modelName)}`);
    if (!resp.ok) {
      throw new Error(\`Failed to fetch card: status \${resp.status}\`);
    }
    const body = await resp.text();

    const isHF = modelName.includes('hf.co/') || modelName.includes('/');
    if (isHF) {
      if (window.marked) {
        container.innerHTML = marked.parse(body);
        container.classList.remove('font-mono');
        container.classList.add('prose', 'prose-invert', 'max-w-none', 'p-2');
      } else {
        container.textContent = body;
      }
    } else {
      const parser = new DOMParser();
      const doc = parser.parseFromString(body, 'text/html');
      const displayDiv = doc.getElementById('display') || doc.getElementById('readme') || doc.querySelector('.prose');
      if (displayDiv) {
        displayDiv.querySelectorAll('a').forEach(a => {
          a.setAttribute('target', '_blank');
          a.classList.add('text-[#88c0d0]', 'hover:underline');
        });
        container.innerHTML = displayDiv.innerHTML;
        container.classList.remove('font-mono');
        container.classList.add('prose', 'prose-invert', 'max-w-none', 'p-2');
      } else {
        container.innerHTML = doc.body.innerHTML;
        container.classList.remove('font-mono');
        container.classList.add('prose', 'prose-invert', 'max-w-none', 'p-2');
      }
    }
  } catch (err) {
    container.textContent = \`Error loading model card: \${err.message}\\n\\nYou can view the library page online at:\\n- Ollama: https://ollama.com/library/\${modelName.split(':')[0]}\\n- HuggingFace: https://huggingface.co/\${modelName}\`;
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
      throw new Error(\`Server returned \${response.status}: \${errText}\`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\\n');
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
      showToast(\`Generation error: \${err.message}\`, 'error');
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

let telemetryEventSource = null;
let telemetryHistory = [];
const MAX_TELEMETRY_POINTS = 50;

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
    nodeBadge.textContent = isRemote ? `REMOTE NODE: ${host}` : "LOCAL NODE";
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

  // Update CPU/RAM bars
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

  let maxVramInHistory = 8;
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
    
    let rgbPrefix = color.substring(0, color.length - 1);
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, `${rgbPrefix}, 0.15)`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fill();
  }

  drawLine('cpu', 'rgba(136, 192, 208, 1)', 100);
  drawLine('ram', 'rgba(163, 190, 140, 1)', 100);
  drawLine('vram', 'rgba(235, 203, 139, 1)', maxVramInHistory);

  ctx.font = '9px monospace';
  ctx.fillStyle = '#88c0d0';
  ctx.fillText(`CPU: ${cpuVal.toFixed(1)}%`, 10, 15);
  ctx.fillStyle = '#a3be8c';
  ctx.fillText(`RAM: ${ramVal.toFixed(1)}%`, 10, 27);
  ctx.fillStyle = '#ebcb8b';
  ctx.fillText(`VRAM: ${vramGb.toFixed(2)} GB (Max Scale: ${maxVramInHistory}GB)`, 10, 39);
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

// --- INFERENCE BENCHMARKER ---

let benchmarkEventSource = null;

function startBenchmark() {
  const modelSelect = document.getElementById('benchmark-model-select');
  if (!modelSelect) return;
  
  const model = modelSelect.value;
  if (!model) {
    showToast('Please select a model to benchmark', 'warning');
    return;
  }
  
  const runBtn = document.getElementById('run-benchmark-btn');
  const logContainer = document.getElementById('benchmark-log');
  
  if (runBtn) runBtn.disabled = true;
  if (logContainer) {
    logContainer.innerHTML = `<div class="text-[#88c0d0] uppercase animate-pulse">Initializing sequential benchmark suite for ${model}...</div>`;
  }
  
  if (benchmarkEventSource) {
    benchmarkEventSource.close();
  }
  
  const url = `/api/benchmarks/run?model=${encodeURIComponent(model)}`;
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
    if (runBtn) runBtn.disabled = false;
    showToast('Benchmark run failed', 'error');
  });
  
  benchmarkEventSource.addEventListener('done', (e) => {
    try {
      const res = JSON.parse(e.data);
      if (logContainer) {
        const div = document.createElement('div');
        div.className = 'text-[#a3be8c] font-bold mt-2 border-t border-[#a3be8c]/20 pt-1';
        div.textContent = `[COMPLETED] Leaderboard record saved: TTFT = ${res.ttft_ms.toFixed(1)}ms, TPS = ${res.tps.toFixed(1)}`;
        logContainer.appendChild(div);
        logContainer.scrollTop = logContainer.scrollHeight;
      }
      showToast('Benchmark completed and saved to leaderboard!', 'success');
      fetchBenchmarks();
    } catch (err) {
      console.error(err);
    } finally {
      benchmarkEventSource.close();
      if (runBtn) runBtn.disabled = false;
    }
  });
  
  benchmarkEventSource.onerror = (err) => {
    console.warn('Benchmark EventSource error:', err);
    benchmarkEventSource.close();
    if (runBtn) runBtn.disabled = false;
  };
}

async function fetchBenchmarks() {
  const tbody = document.getElementById('benchmark-leaderboard-body');
  if (!tbody) return;
  
  try {
    const response = await fetch('/api/benchmarks');
    if (!response.ok) throw new Error('Failed to fetch benchmark leaderboard');
    const list = await response.json();
    
    if (!list || list.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="text-center py-12 text-[#4c566a] italic">
            No benchmarking runs recorded. Select a model on the left to begin.
          </td>
        </tr>
      `;
      return;
    }
    
    tbody.innerHTML = list.map(b => {
      let scoreBadge = '';
      if (b.reasoning_score.includes('S')) {
        scoreBadge = 'bg-[#a3be8c]/25 text-[#a3be8c] border-[#a3be8c]';
      } else if (b.reasoning_score.includes('A') || b.reasoning_score.includes('B')) {
        scoreBadge = 'bg-[#88c0d0]/25 text-[#88c0d0] border-[#88c0d0]';
      } else if (b.reasoning_score.includes('C')) {
        scoreBadge = 'bg-[#ebcb8b]/25 text-[#ebcb8b] border-[#ebcb8b]';
      } else if (b.reasoning_score.includes('F')) {
        scoreBadge = 'bg-[#bf616a]/25 text-[#bf616a] border-[#bf616a]';
      } else {
        scoreBadge = 'bg-[#4c566a]/25 text-[#d8dee9] border-[#4c566a]';
      }
      
      const noteHtml = b.notes 
        ? `<div class="text-[10px] text-[#4c566a] mt-0.5 max-w-[250px] truncate" title="${escapeHTML(b.notes)}">${escapeHTML(b.notes)}</div>` 
        : '';
        
      return `
        <tr class="hover:bg-[#3b4252]/20 border-b border-[#4c566a]/20 transition-colors">
          <td class="py-3 text-left font-mono">
            <div class="font-bold text-[#e5e9f0]">${escapeHTML(b.model_name)}</div>
            ${noteHtml}
          </td>
          <td class="text-center">${b.ttft_ms.toFixed(1)} ms</td>
          <td class="text-center font-bold text-[#88c0d0]">${b.tps.toFixed(1)}</td>
          <td class="text-center">${b.avg_latency_ms.toFixed(0)} ms</td>
          <td class="text-center">
            <span class="border px-2 py-0.5 rounded text-[9px] font-bold ${scoreBadge}">
              ${escapeHTML(b.reasoning_score)}
            </span>
          </td>
          <td class="text-right">
            <div class="flex gap-1 justify-end">
              <button onclick="openScoreModal(${b.id}, '${escapeHTML(b.reasoning_score)}', '${escapeHTML(b.notes)}')" 
                      class="btn btn-xs btn-neutral border-[#4c566a] font-tech text-[9px] px-2">
                RATE
              </button>
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
        <td colspan="6" class="text-center py-8 text-[#bf616a] italic">
          Failed to load leaderboard: ${error.message}
        </td>
      </tr>
    `;
  }
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
  
  if (tab === 'standard') {
    if (standardBtn) standardBtn.classList.add('tab-active');
    if (optimizerBtn) optimizerBtn.classList.remove('tab-active');
    if (standardContainer) standardContainer.classList.remove('hidden');
    if (optimizerContainer) optimizerContainer.classList.add('hidden');
  } else {
    if (standardBtn) standardBtn.classList.remove('tab-active');
    if (optimizerBtn) optimizerBtn.classList.add('tab-active');
    if (standardContainer) standardContainer.classList.add('hidden');
    if (optimizerContainer) optimizerContainer.classList.remove('hidden');
    
    loadOptimizerHistory();
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
    loadOptimizerHistory();
  });
  
  optimizerEventSource.onerror = (err) => {
    console.warn('Optimizer EventSource error:', err);
    optimizerEventSource.close();
    if (runBtn) runBtn.disabled = false;
  };
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

