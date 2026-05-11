import express from 'express';
import http from 'http';
import net from 'net';
import path from 'path';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '3000', 10);
const SOCKS_PORT = parseInt(process.env.SOCKS_PORT || '1080', 10);
const RUNTIME_CONFIG_PATH = path.join(__dirname, 'public', 'runtime-config.json');

type ProxyStats = {
  connectionsAccepted: number;
  connectionFailures: number;
  activeConnections: number;
  bytesUploaded: number;
  bytesDownloaded: number;
};

type RuntimeConfig = {
  proxyScheme: string;
  authMode: string;
  dashboardUrl: string;
  socksProxyEndpoint: string;
  socksProxyHost: string;
  socksProxyPort: number;
  chromeLaunchCommand: string;
};

type TunnelState = {
  client: net.Socket;
  upstream: net.Socket | null;
  buffer: Buffer;
  phase: 'greeting' | 'request' | 'connecting' | 'connected';
  established: boolean;
  cleanedUp: boolean;
};

type ParsedRequest = {
  bytesConsumed: number;
  host: string;
  port: number;
};

const enum SocksReply {
  Success = 0x00,
  GeneralFailure = 0x01,
  ConnectionNotAllowed = 0x02,
  NetworkUnreachable = 0x03,
  HostUnreachable = 0x04,
  ConnectionRefused = 0x05,
  CommandNotSupported = 0x07,
  AddressTypeNotSupported = 0x08,
}

console.log(`\n========================================`);
console.log(`[web]   Burner VPN Server`);
console.log(`[web]   PORT       = ${PORT}`);
console.log(`[socks] SOCKS_PORT = ${SOCKS_PORT}`);
console.log(`========================================\n`);

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

let stats: ProxyStats = {
  connectionsAccepted: 0,
  connectionFailures: 0,
  activeConnections: 0,
  bytesUploaded: 0,
  bytesDownloaded: 0,
};
let sseClients: express.Response[] = [];

function broadcastStats() {
  const data = `data: ${JSON.stringify(stats)}\n\n`;
  sseClients.forEach((client) => client.write(data));
}

async function loadRuntimeConfig() {
  try {
    return JSON.parse(await readFile(RUNTIME_CONFIG_PATH, 'utf8')) as RuntimeConfig;
  } catch {
    return null;
  }
}

function sendReply(socket: net.Socket, reply: SocksReply, port = 0) {
  const response = Buffer.from([
    0x05,
    reply,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x00,
    (port >> 8) & 0xff,
    port & 0xff,
  ]);
  socket.write(response);
}

function parseSocksRequest(buffer: Buffer): ParsedRequest | null {
  if (buffer.length < 4) {
    return null;
  }

  const version = buffer[0];
  const command = buffer[1];
  const addressType = buffer[3];

  if (version !== 0x05 || command !== 0x01) {
    return { bytesConsumed: buffer.length, host: '', port: -1 };
  }

  if (addressType === 0x01) {
    if (buffer.length < 10) {
      return null;
    }

    const host = `${buffer[4]}.${buffer[5]}.${buffer[6]}.${buffer[7]}`;
    const port = buffer.readUInt16BE(8);
    return { bytesConsumed: 10, host, port };
  }

  if (addressType === 0x03) {
    if (buffer.length < 5) {
      return null;
    }

    const hostLength = buffer[4];
    const end = 5 + hostLength;
    if (buffer.length < end + 2) {
      return null;
    }

    const host = buffer.subarray(5, end).toString('utf8');
    const port = buffer.readUInt16BE(end);
    return { bytesConsumed: end + 2, host, port };
  }

  if (addressType === 0x04) {
    if (buffer.length < 22) {
      return null;
    }

    const parts: string[] = [];
    for (let index = 4; index < 20; index += 2) {
      parts.push(buffer.readUInt16BE(index).toString(16));
    }
    const host = parts.join(':');
    const port = buffer.readUInt16BE(20);
    return { bytesConsumed: 22, host, port };
  }

  return { bytesConsumed: buffer.length, host: '', port: -2 };
}

function mapSocketError(error: NodeJS.ErrnoException | undefined) {
  switch (error?.code) {
    case 'ECONNREFUSED':
      return SocksReply.ConnectionRefused;
    case 'ENETUNREACH':
      return SocksReply.NetworkUnreachable;
    case 'EHOSTUNREACH':
    case 'ENOTFOUND':
      return SocksReply.HostUnreachable;
    case 'EACCES':
      return SocksReply.ConnectionNotAllowed;
    default:
      return SocksReply.GeneralFailure;
  }
}

function cleanupTunnel(state: TunnelState) {
  if (state.cleanedUp) {
    return;
  }

  state.cleanedUp = true;
  if (state.established) {
    stats.activeConnections = Math.max(0, stats.activeConnections - 1);
    broadcastStats();
  }

  if (state.upstream && !state.upstream.destroyed) {
    state.upstream.destroy();
  }
  if (!state.client.destroyed) {
    state.client.destroy();
  }
}

function startTunnel(state: TunnelState, host: string, port: number, initialPayload: Buffer) {
  state.phase = 'connecting';
  const upstream = net.createConnection({ host, port });
  state.upstream = upstream;

  upstream.on('connect', () => {
    state.phase = 'connected';
    state.established = true;
    stats.connectionsAccepted += 1;
    stats.activeConnections += 1;
    broadcastStats();
    sendReply(state.client, SocksReply.Success, upstream.localPort ?? 0);

    if (initialPayload.length > 0) {
      stats.bytesUploaded += initialPayload.length;
      broadcastStats();
      upstream.write(initialPayload);
    }
  });

  upstream.on('data', (chunk: Buffer) => {
    if (!state.client.destroyed) {
      stats.bytesDownloaded += chunk.length;
      broadcastStats();
      state.client.write(chunk);
    }
  });

  upstream.on('error', (error: NodeJS.ErrnoException) => {
    if (!state.established && !state.client.destroyed) {
      stats.connectionFailures += 1;
      broadcastStats();
      sendReply(state.client, mapSocketError(error));
    }
    cleanupTunnel(state);
  });

  upstream.on('close', () => {
    cleanupTunnel(state);
  });
}

function processHandshake(state: TunnelState) {
  if (state.phase === 'greeting') {
    if (state.buffer.length < 2) {
      return;
    }

    const version = state.buffer[0];
    const methodCount = state.buffer[1];
    const totalGreetingBytes = 2 + methodCount;
    if (state.buffer.length < totalGreetingBytes) {
      return;
    }

    if (version !== 0x05) {
      state.client.destroy();
      return;
    }

    const methods = state.buffer.subarray(2, totalGreetingBytes);
    if (!methods.includes(0x00)) {
      state.client.write(Buffer.from([0x05, 0xff]));
      state.client.destroy();
      return;
    }

    state.client.write(Buffer.from([0x05, 0x00]));
    state.buffer = state.buffer.subarray(totalGreetingBytes);
    state.phase = 'request';
  }

  if (state.phase !== 'request') {
    return;
  }

  const parsedRequest = parseSocksRequest(state.buffer);
  if (!parsedRequest) {
    return;
  }

  if (parsedRequest.port === -1) {
    sendReply(state.client, SocksReply.CommandNotSupported);
    state.client.destroy();
    return;
  }

  if (parsedRequest.port === -2 || !parsedRequest.host || parsedRequest.port <= 0 || parsedRequest.port > 65535) {
    sendReply(state.client, SocksReply.AddressTypeNotSupported);
    state.client.destroy();
    return;
  }

  const initialPayload = state.buffer.subarray(parsedRequest.bytesConsumed);
  state.buffer = Buffer.alloc(0);
  startTunnel(state, parsedRequest.host, parsedRequest.port, initialPayload);
}

const socksServer = net.createServer((client) => {
  const state: TunnelState = {
    client,
    upstream: null,
    buffer: Buffer.alloc(0),
    phase: 'greeting',
    established: false,
    cleanedUp: false,
  };

  client.on('data', (chunk: Buffer) => {
    if (state.phase === 'connected') {
      if (state.upstream && !state.upstream.destroyed) {
        stats.bytesUploaded += chunk.length;
        broadcastStats();
        state.upstream.write(chunk);
      }
      return;
    }

    state.buffer = Buffer.concat([state.buffer, chunk]);
    processHandshake(state);
  });

  client.on('error', () => {
    cleanupTunnel(state);
  });

  client.on('close', () => {
    cleanupTunnel(state);
  });
});

socksServer.on('error', (error) => {
  console.error(`[socks] ❌ SOCKS5 server error: ${error.message}`);
  process.exit(1);
});

app.get('/api/runtime-config', async (_req, res) => {
  const runtimeConfig = await loadRuntimeConfig();
  res.json(runtimeConfig ?? {
    proxyScheme: 'socks5',
    authMode: 'none',
  });
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

server.listen(PORT, () => {
  console.log(`[web]   ✅ Dashboard listening on port ${PORT}`);
});

socksServer.listen(SOCKS_PORT, '0.0.0.0', () => {
  console.log(`[socks] ✅ SOCKS5 proxy listening on port ${SOCKS_PORT} (no auth)`);
});
