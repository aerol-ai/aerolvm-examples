import express from 'express';
import http from 'http';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '3000', 10);
const PROXY_USER = process.env.PROXY_USER || 'admin';
const PROXY_PASS = process.env.PROXY_PASS || 'burner123';
const RELAY_PATH = '/ws-relay';
const REQUEST_TIMEOUT_MS = 30_000;

type RelayHeader = {
  name: string;
  value: string;
};

type RelayStats = {
  requestsProxied: number;
  bytesRelayed: number;
  activeRelayClients: number;
};

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

console.log(`\n========================================`);
console.log(`[web]   Burner VPN Server`);
console.log(`[web]   PORT       = ${PORT}`);
console.log(`[proxy] PROXY_USER = ${PROXY_USER}`);
console.log(`========================================\n`);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sanitizeRequestHeaders(headers: RelayHeader[]) {
  const sanitized: Record<string, string> = {};
  for (const header of headers) {
    const name = header.name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name) || name === 'content-length' || name === 'host') {
      continue;
    }
    sanitized[header.name] = header.value;
  }
  return sanitized;
}

function extractRelayHeaders(rawHeaders: string[], bodyLength: number, statusCode: number, method: string) {
  const headers: RelayHeader[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1] ?? '';
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || name.toLowerCase() === 'content-length') {
      continue;
    }
    headers.push({ name, value });
  }

  const canHaveBody = method !== 'HEAD' && statusCode !== 204 && statusCode !== 304 && (statusCode < 100 || statusCode >= 200);
  if (canHaveBody) {
    headers.push({ name: 'content-length', value: String(bodyLength) });
  }

  return headers;
}

async function relayHTTPRequest(message: {
  id: string;
  method: string;
  url: string;
  headers: RelayHeader[];
  bodyBase64?: string;
}) {
  const targetUrl = new URL(message.url);
  const transport = targetUrl.protocol === 'https:' ? https : http;
  const requestBody = message.bodyBase64 ? Buffer.from(message.bodyBase64, 'base64') : undefined;

  return await new Promise<{
    status: number;
    statusText: string;
    headers: RelayHeader[];
    body: Buffer;
  }>((resolve, reject) => {
    const upstream = transport.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || undefined,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: message.method,
        headers: sanitizeRequestHeaders(message.headers),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const body = Buffer.concat(chunks);
          const status = response.statusCode ?? 502;
          resolve({
            status,
            statusText: response.statusMessage ?? 'OK',
            headers: extractRelayHeaders(response.rawHeaders, body.length, status, message.method),
            body,
          });
        });
      },
    );

    upstream.on('error', reject);
    upstream.setTimeout(REQUEST_TIMEOUT_MS, () => {
      upstream.destroy(new Error(`Upstream request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });

    if (requestBody && requestBody.length > 0) {
      upstream.write(requestBody);
    }

    upstream.end();
  });
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

let stats: RelayStats = { requestsProxied: 0, bytesRelayed: 0, activeRelayClients: 0 };
let sseClients: express.Response[] = [];

function broadcastStats() {
  const data = `data: ${JSON.stringify(stats)}\n\n`;
  sseClients.forEach((client) => client.write(data));
}

app.get('/api/credentials', (_req, res) => {
  res.json({ username: PROXY_USER, password: PROXY_PASS, relayPath: RELAY_PATH });
});

app.get('/api/stats/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.push(res);
  res.write(`data: ${JSON.stringify(stats)}\n\n`);
  console.log(`[web] SSE client connected (total: ${sseClients.length})`);
  req.on('close', () => {
    sseClients = sseClients.filter((client) => client !== res);
    console.log(`[web] SSE client disconnected (total: ${sseClients.length})`);
  });
});

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: RELAY_PATH });

wss.on('connection', (ws: WebSocket) => {
  console.log(`[ws] New WebSocket connection`);
  let authenticated = false;

  ws.on('message', (raw: Buffer | string) => {
    let message: unknown;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      return;
    }

    if (!isRecord(message)) {
      return;
    }

    if (message.type === 'auth') {
      const expected = `${PROXY_USER}:${PROXY_PASS}`;
      if (message.token === expected) {
        authenticated = true;
        stats.activeRelayClients += 1;
        broadcastStats();
        ws.send(JSON.stringify({ type: 'auth_ok' }));
        console.log(`[ws] Client authenticated`);
      } else {
        ws.send(JSON.stringify({ type: 'auth_fail', message: 'Bad username or password' }));
        console.log(`[ws] ❌ Auth failed`);
        ws.close();
      }
      return;
    }

    if (message.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    if (!authenticated) {
      ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
      ws.close();
      return;
    }

    if (message.type !== 'http_request') {
      ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
      return;
    }

    const id = typeof message.id === 'string' ? message.id : '';
    const method = typeof message.method === 'string' ? message.method : '';
    const url = typeof message.url === 'string' ? message.url : '';
    const headers = Array.isArray(message.headers)
      ? message.headers.filter(
          (header): header is RelayHeader => isRecord(header) && typeof header.name === 'string' && typeof header.value === 'string',
        )
      : [];
    const bodyBase64 = typeof message.bodyBase64 === 'string' ? message.bodyBase64 : undefined;

    if (!id || !method || !url) {
      ws.send(JSON.stringify({ type: 'error', id, message: 'Missing required request fields' }));
      return;
    }

    console.log(`[ws] ${method} ${url}`);
    void relayHTTPRequest({ id, method, url, headers, bodyBase64 })
      .then((response) => {
        stats.requestsProxied += 1;
        stats.bytesRelayed += response.body.length + (bodyBase64 ? Buffer.byteLength(bodyBase64, 'base64') : 0);
        broadcastStats();

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'http_response',
              id,
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
              bodyBase64: response.body.toString('base64'),
            }),
          );
        }
      })
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : String(error);
        console.log(`[ws] Relay error for ${method} ${url}: ${messageText}`);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'error', id, message: messageText }));
        }
      });
  });

  ws.on('close', () => {
    if (authenticated) {
      stats.activeRelayClients = Math.max(0, stats.activeRelayClients - 1);
      broadcastStats();
    }
    console.log(`[ws] WebSocket disconnected`);
  });
});

server.listen(PORT, () => {
  console.log(`[web]   ✅ Dashboard listening on port ${PORT}`);
  console.log(`[ws]    ✅ WebSocket relay ready at ws://0.0.0.0:${PORT}${RELAY_PATH}`);
});
