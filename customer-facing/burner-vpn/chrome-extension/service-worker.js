const attachedTabs = new Map();

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const slice = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function stringToBase64(value) {
  return bytesToBase64(new TextEncoder().encode(value));
}

function headerObjectToList(headers) {
  return Object.entries(headers || {}).map(([name, value]) => ({
    name,
    value: Array.isArray(value) ? value.join(', ') : String(value),
  }));
}

function normalizeDashboardUrl(value) {
  const normalized = new URL(value);
  if (normalized.protocol !== 'http:' && normalized.protocol !== 'https:') {
    throw new Error('Dashboard URLs must use http or https.');
  }
  normalized.pathname = '/';
  normalized.search = '';
  normalized.hash = '';
  return normalized.toString().replace(/\/$/, '');
}

function relayUrlFromDashboard(dashboardUrl) {
  const relayUrl = new URL('/ws-relay', dashboardUrl.endsWith('/') ? dashboardUrl : `${dashboardUrl}/`);
  relayUrl.protocol = relayUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return relayUrl.toString();
}

function normalizeConfig(rawConfig) {
  const dashboardUrl = normalizeDashboardUrl(String(rawConfig?.dashboardUrl || '').trim());
  const proxyUser = String(rawConfig?.proxyUser || '').trim();
  const proxyPass = String(rawConfig?.proxyPass || '');

  if (!dashboardUrl) {
    throw new Error('Enter a dashboard URL.');
  }

  if (!proxyUser || !proxyPass) {
    throw new Error('Enter both the username and password.');
  }

  return {
    dashboardUrl,
    relayWebSocketUrl: relayUrlFromDashboard(dashboardUrl),
    proxyUser,
    proxyPass,
  };
}

class RelayClient {
  constructor(config) {
    this.config = config;
    this.socket = null;
    this.connectPromise = null;
    this.pendingAuth = null;
    this.pendingRequests = new Map();
    this.pingTimer = null;
  }

  async connect() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN && !this.pendingAuth) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.config.relayWebSocketUrl);
      this.socket = socket;
      this.pendingAuth = { resolve, reject };

      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({
          type: 'auth',
          token: `${this.config.proxyUser}:${this.config.proxyPass}`,
        }));
      });

      socket.addEventListener('message', (event) => this.handleMessage(event));
      socket.addEventListener('close', () => this.handleClose('Relay disconnected.'));
      socket.addEventListener('error', () => this.handleClose('Relay connection error.'));
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  handleMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.type === 'auth_ok') {
      const pendingAuth = this.pendingAuth;
      this.pendingAuth = null;
      this.startPingLoop();
      pendingAuth?.resolve();
      return;
    }

    if (message.type === 'auth_fail') {
      const messageText = typeof message.message === 'string' ? message.message : 'Authentication failed.';
      const pendingAuth = this.pendingAuth;
      this.pendingAuth = null;
      pendingAuth?.reject(new Error(messageText));
      this.close(messageText);
      return;
    }

    if (message.type === 'pong') {
      return;
    }

    if (message.type === 'http_response' && typeof message.id === 'string') {
      const pendingRequest = this.pendingRequests.get(message.id);
      if (pendingRequest) {
        this.pendingRequests.delete(message.id);
        pendingRequest.resolve(message);
      }
      return;
    }

    if (message.type === 'error') {
      const messageText = typeof message.message === 'string' ? message.message : 'Relay error.';
      if (typeof message.id === 'string') {
        const pendingRequest = this.pendingRequests.get(message.id);
        if (pendingRequest) {
          this.pendingRequests.delete(message.id);
          pendingRequest.reject(new Error(messageText));
          return;
        }
      }

      const pendingAuth = this.pendingAuth;
      this.pendingAuth = null;
      pendingAuth?.reject(new Error(messageText));
    }
  }

  handleClose(reason) {
    this.stopPingLoop();

    const pendingAuth = this.pendingAuth;
    this.pendingAuth = null;
    pendingAuth?.reject(new Error(reason));

    for (const pendingRequest of this.pendingRequests.values()) {
      pendingRequest.reject(new Error(reason));
    }
    this.pendingRequests.clear();
    this.socket = null;
  }

  startPingLoop() {
    if (this.pingTimer) {
      return;
    }

    this.pingTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: 'ping' }));
      }
    }, 20_000);
  }

  stopPingLoop() {
    if (!this.pingTimer) {
      return;
    }

    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  async sendRequest(payload) {
    await this.connect();

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Relay is not connected.');
    }

    return await new Promise((resolve, reject) => {
      this.pendingRequests.set(payload.id, { resolve, reject });
      try {
        this.socket.send(JSON.stringify(payload));
      } catch (error) {
        this.pendingRequests.delete(payload.id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(reason = 'Relay closed.') {
    const socket = this.socket;
    this.handleClose(reason);
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close();
    }
  }
}

async function getRequestBodyBase64(source, params) {
  if (typeof params?.request?.postData === 'string') {
    return stringToBase64(params.request.postData);
  }

  if (typeof params?.networkId === 'string') {
    try {
      const result = await chrome.debugger.sendCommand(source, 'Network.getRequestPostData', {
        requestId: params.networkId,
      });
      if (typeof result?.postData === 'string') {
        return stringToBase64(result.postData);
      }
    } catch {
      return undefined;
    }
  }

  return undefined;
}

async function persistStatus(tabId, message) {
  await chrome.storage.local.set({
    lastStatus: {
      tabId,
      message,
      updatedAt: Date.now(),
    },
  });
}

async function attachTab(tabId, rawConfig) {
  const config = normalizeConfig(rawConfig);

  if (attachedTabs.has(tabId)) {
    await detachTab(tabId, 'Reattaching the current tab.');
  }

  const relay = new RelayClient(config);

  try {
    await relay.connect();
    await chrome.debugger.attach({ tabId }, '1.3');
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {
      patterns: [
        { urlPattern: 'http://*/*', requestStage: 'Request' },
        { urlPattern: 'https://*/*', requestStage: 'Request' },
      ],
    });
  } catch (error) {
    relay.close('Attach failed.');
    throw error;
  }

  attachedTabs.set(tabId, { relay, config });
  await chrome.storage.local.set({ lastConfig: config });
  await persistStatus(tabId, 'Attached. Reloaded requests now go through the sandbox relay.');
}

async function detachTab(tabId, reason = 'Detached. This tab is browsing directly.') {
  const state = attachedTabs.get(tabId);
  attachedTabs.delete(tabId);

  if (state) {
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Fetch.disable');
    } catch {
      // Ignore cleanup failures.
    }

    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // Ignore cleanup failures.
    }

    state.relay.close(reason);
  }

  await persistStatus(tabId, reason);
}

async function getState(tabId) {
  const stored = await chrome.storage.local.get(['lastConfig', 'lastStatus']);
  const currentTabAttached = typeof tabId === 'number' && attachedTabs.has(tabId);

  return {
    lastConfig: stored.lastConfig || null,
    lastStatusMessage: stored.lastStatus?.message || '',
    currentTabAttached,
  };
}

async function handleRequestPaused(source, params) {
  const tabId = source.tabId;
  if (typeof tabId !== 'number') {
    return;
  }

  const state = attachedTabs.get(tabId);
  if (!state) {
    return;
  }

  const requestId = params?.requestId;
  const request = params?.request;
  if (!requestId || !request?.url || !request?.method) {
    return;
  }

  if (!/^https?:/i.test(request.url) || params.resourceType === 'WebSocket') {
    await chrome.debugger.sendCommand(source, 'Fetch.continueRequest', { requestId });
    return;
  }

  try {
    const bodyBase64 = await getRequestBodyBase64(source, params);
    const response = await state.relay.sendRequest({
      type: 'http_request',
      id: requestId,
      method: request.method,
      url: request.url,
      headers: headerObjectToList(request.headers),
      bodyBase64,
    });

    await chrome.debugger.sendCommand(source, 'Fetch.fulfillRequest', {
      requestId,
      responseCode: response.status,
      responsePhrase: response.statusText,
      responseHeaders: Array.isArray(response.headers) ? response.headers : [],
      body: typeof response.bodyBase64 === 'string' ? response.bodyBase64 : '',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await persistStatus(tabId, message);

    try {
      await chrome.debugger.sendCommand(source, 'Fetch.failRequest', {
        requestId,
        errorReason: 'Failed',
      });
    } catch {
      // Ignore follow-up cleanup failures.
    }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    if (message?.type === 'get_state') {
      return { state: await getState(message.tabId) };
    }

    if (message?.type === 'attach_tab') {
      await attachTab(message.tabId, message.config);
      return { attached: true };
    }

    if (message?.type === 'detach_tab') {
      await detachTab(message.tabId);
      return { detached: true };
    }

    throw new Error('Unknown message type.');
  })()
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });

  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void detachTab(tabId, 'The tab was closed.');
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (typeof source.tabId === 'number' && attachedTabs.has(source.tabId)) {
    void detachTab(source.tabId, `Debugger detached: ${reason}`);
  }
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === 'Fetch.requestPaused') {
    void handleRequestPaused(source, params);
  }
});