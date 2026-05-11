const elements = {
  status: document.getElementById('status'),
  dashboardUrl: document.getElementById('dashboardUrl'),
  proxyUser: document.getElementById('proxyUser'),
  proxyPass: document.getElementById('proxyPass'),
  relayUrlHint: document.getElementById('relayUrlHint'),
  attachBtn: document.getElementById('attachBtn'),
  detachBtn: document.getElementById('detachBtn'),
  tabMeta: document.getElementById('tabMeta'),
};

function setStatus(message, tone = 'idle') {
  elements.status.textContent = message;
  elements.status.className = `status ${tone}`;
}

function relayUrlFromDashboard(dashboardUrl) {
  const normalized = new URL(dashboardUrl);
  if (normalized.protocol !== 'http:' && normalized.protocol !== 'https:') {
    throw new Error('Dashboard URLs must use http or https.');
  }
  normalized.pathname = '/ws-relay';
  normalized.search = '';
  normalized.hash = '';
  normalized.protocol = normalized.protocol === 'https:' ? 'wss:' : 'ws:';
  return normalized.toString();
}

function syncRelayHint() {
  const rawDashboardUrl = elements.dashboardUrl.value.trim();
  if (!rawDashboardUrl) {
    elements.relayUrlHint.textContent = 'Relay WebSocket: waiting for a valid dashboard URL';
    return;
  }

  try {
    elements.relayUrlHint.textContent = `Relay WebSocket: ${relayUrlFromDashboard(rawDashboardUrl)}`;
  } catch {
    elements.relayUrlHint.textContent = 'Relay WebSocket: invalid dashboard URL';
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refreshState() {
  const tab = await getActiveTab();
  elements.tabMeta.textContent = tab ? `Current tab: ${tab.title || tab.url || `#${tab.id}`}` : 'Current tab: unavailable';

  const response = await chrome.runtime.sendMessage({ type: 'get_state', tabId: tab?.id });
  if (!response?.ok) {
    setStatus(response?.error || 'Could not load extension state.', 'error');
    return;
  }

  const { state } = response;
  if (state.lastConfig) {
    elements.dashboardUrl.value = state.lastConfig.dashboardUrl || '';
    elements.proxyUser.value = state.lastConfig.proxyUser || '';
    elements.proxyPass.value = state.lastConfig.proxyPass || '';
  }

  syncRelayHint();

  if (state.currentTabAttached) {
    setStatus('Attached. Requests in this tab are being relayed through the sandbox.', 'active');
  } else if (state.lastStatusMessage) {
    setStatus(state.lastStatusMessage, 'idle');
  } else {
    setStatus('Detached. This tab is browsing directly.', 'idle');
  }

  elements.attachBtn.disabled = !tab || state.currentTabAttached;
  elements.detachBtn.disabled = !tab || !state.currentTabAttached;
}

async function attachCurrentTab() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    setStatus('No active tab is available to attach.', 'error');
    return;
  }

  const config = {
    dashboardUrl: elements.dashboardUrl.value.trim(),
    proxyUser: elements.proxyUser.value.trim(),
    proxyPass: elements.proxyPass.value,
  };

  setStatus('Attaching the relay and reloading the tab…', 'pending');
  const response = await chrome.runtime.sendMessage({ type: 'attach_tab', tabId: tab.id, config });
  if (!response?.ok) {
    setStatus(response?.error || 'Could not attach the relay.', 'error');
    return;
  }

  await chrome.tabs.reload(tab.id);
  await refreshState();
}

async function detachCurrentTab() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    setStatus('No active tab is available to detach.', 'error');
    return;
  }

  setStatus('Detaching the relay and reloading the tab…', 'pending');
  const response = await chrome.runtime.sendMessage({ type: 'detach_tab', tabId: tab.id });
  if (!response?.ok) {
    setStatus(response?.error || 'Could not detach the relay.', 'error');
    return;
  }

  await chrome.tabs.reload(tab.id);
  await refreshState();
}

elements.dashboardUrl.addEventListener('input', syncRelayHint);
elements.attachBtn.addEventListener('click', () => {
  void attachCurrentTab();
});
elements.detachBtn.addEventListener('click', () => {
  void detachCurrentTab();
});

document.addEventListener('DOMContentLoaded', () => {
  syncRelayHint();
  void refreshState();
});