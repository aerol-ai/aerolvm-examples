import express from 'express';
import { Server as ProxyChainServer } from 'proxy-chain';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '3000', 10);
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '8080', 10);
const PROXY_USER = process.env.PROXY_USER || 'admin';
const PROXY_PASS = process.env.PROXY_PASS || 'burner123';

console.log(`\n========================================`);
console.log(`[web] Burner VPN Backend Server`);
console.log(`[web]   PORT       = ${PORT}`);
console.log(`[proxy] PROXY_PORT = ${PROXY_PORT}`);
console.log(`[proxy] PROXY_USER = ${PROXY_USER}`);
console.log(`========================================\n`);

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

let stats = {
  requestsHandled: 0
};

let clients: express.Response[] = [];

function broadcastStats() {
  const data = `data: ${JSON.stringify(stats)}\n\n`;
  clients.forEach(client => client.write(data));
}

app.get('/api/credentials', (req, res) => {
  res.json({
    proxyPort: PROXY_PORT,
    username: PROXY_USER,
    password: PROXY_PASS
  });
});

app.get('/api/stats/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  clients.push(res);
  res.write(`data: ${JSON.stringify(stats)}\n\n`);

  console.log(`[web] Client connected to live stats stream (Total clients: ${clients.length})`);

  req.on('close', () => {
    clients = clients.filter(client => client !== res);
    console.log(`[web] Client disconnected from live stats stream (Total clients: ${clients.length})`);
  });
});

app.listen(PORT, () => {
  console.log(`[web] ✅ Web Dashboard listening on port ${PORT}`);
});

const proxyServer = new ProxyChainServer({
  port: PROXY_PORT,
  prepareRequestFunction: ({ request, username, password }) => {
    stats.requestsHandled++;
    broadcastStats();

    if (username !== PROXY_USER || password !== PROXY_PASS) {
      console.log(`[proxy] ❌ Authentication failed for ${request.url}`);
      return {
        requestAuthentication: true,
        failMsg: 'Bad username or password',
      };
    }
    
    console.log(`[proxy] 🟢 Authenticated request to: ${request.url}`);
    return { requestAuthentication: false };
  },
});

proxyServer.listen(() => {
  console.log(`[proxy] ✅ Proxy server is listening on port ${PROXY_PORT}`);
});
