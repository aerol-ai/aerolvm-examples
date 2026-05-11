import { MicroVM } from '@aerol-ai/aerolvm-sdk';
import * as dotenv from 'dotenv';
import { writeFile } from 'fs/promises';
import { setTimeout as delay } from 'timers/promises';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const patToken = process.env.SB_PAT_TOKEN;
const apiUrl = process.env.SB_API_URL ?? "http://127.0.0.1:21212";
const imageName = process.env.IMAGE_NAME ?? 'ghcr.io/aerol-ai/aerolvm-examples-burner-vpn:latest';

console.log(`\n========================================`);
console.log(`[host] Burner VPN Host Script`);
console.log(`[host]   SB_API_URL  = ${apiUrl}`);
console.log(`[host]   SB_PAT_TOKEN = ${patToken ? '***set***' : '(NOT SET)'}`);
console.log(`[host]   IMAGE_NAME  = ${imageName}`);
console.log(`========================================\n`);

if (!patToken) {
  console.error("[host] ❌ Error: SB_PAT_TOKEN is not set in the environment.");
  process.exit(1);
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const wait = Math.min(8000, 1000 * 2 ** i);
      console.log(`[host]   ${label}: attempt ${i + 1}/${attempts} failed; retrying in ${wait}ms`);
      await delay(wait);
    }
  }
  throw lastErr;
}

async function main() {
  const dashboardPort = 3000;
  const socksPort = 1080;

  console.log(`[host] Creating MicroVM client with apiUrl=${apiUrl}`);
  const client = new MicroVM({ apiUrl, patToken });

  console.log(`[host] Creating sandbox with image=${imageName}, cpu=1, memoryMB=1024`);
  console.log(`[host] Env vars being passed to sandbox:`);
  console.log(`[host]   PORT         = ${dashboardPort}`);
  console.log(`[host]   SOCKS_PORT   = ${socksPort}`);

  const createStart = Date.now();
  const sandbox = await client.create({
    image: imageName,
    cpu: 1,
    memoryMB: 1024,
    env: {
      PORT: String(dashboardPort),
      SOCKS_PORT: String(socksPort)
    }
  });

  console.log(`[host] ✅ Sandbox created! ID: ${sandbox.id} (took ${Date.now() - createStart}ms)`);

  console.log(`[host] Waiting for dashboard to be ready on port ${dashboardPort}...`);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    console.log(`[host]   Health check attempt ${attempt + 1}/20...`);
    try {
      const result = await sandbox.exec({
        command: `node -e "const req = require('http').get('http://127.0.0.1:${dashboardPort}', (r) => process.exit(r.statusCode === 200 ? 0 : 1)); req.on('error', () => process.exit(1)); req.setTimeout(2000, () => process.exit(1));"`,
        timeoutSeconds: 5,
      });

      console.log(`[host]   exitCode=${result.exitCode}, stdout=${result.stdout}, stderr=${result.stderr?.substring(0, 200)}`);

      if (result.exitCode === 0) {
        console.log(`[host] ✅ Server is ready!`);
        break;
      }
    } catch (err: any) {
      console.log(`[host]   Exec failed (VM booting?): ${err.message}`);
    }
    
    if (attempt === 19) {
      console.error(`[host] ❌ Server did not become ready after 20 attempts`);
    }
    await delay(1000);
  }

  console.log(`[host] Exposing dashboard HTTP port ${dashboardPort}...`);
  const dashboardExposure = await withRetry(`exposePort(${dashboardPort})`, () => sandbox.exposePort(dashboardPort));
  console.log(`[host] Exposing SOCKS5 TCP port ${socksPort}...`);
  const socksExposure = await withRetry(`exposePort(${socksPort}, tcp)`, () =>
    sandbox.exposePort(socksPort, { protocol: 'tcp' })
  );

  const dashboardUrl = dashboardExposure.url;
  const socksUrl = new URL(socksExposure.url);
  const socksProxyHost = socksUrl.hostname;
  const socksProxyPort = parseInt(socksUrl.port, 10);
  const socksProxyEndpoint = `${socksProxyHost}:${socksProxyPort}`;
  const chromeLaunchCommand = `open -na "Google Chrome" --args --proxy-server="socks5://${socksProxyEndpoint}" --host-resolver-rules="MAP * ~NOTFOUND , EXCLUDE ${socksProxyHost}"`;

  const runtimeConfig = {
    proxyScheme: 'socks5',
    authMode: 'none',
    dashboardUrl,
    socksProxyEndpoint,
    socksProxyHost,
    socksProxyPort,
    chromeLaunchCommand
  };

  await sandbox.uploadFile('/app/public/runtime-config.json', `${JSON.stringify(runtimeConfig, null, 2)}\n`);

  console.log(`\n======================================================`);
  console.log(`[host] 🚀 BURNER SOCKS5 VPN IS LIVE!`);
  console.log(`======================================================`);
  console.log(`[host] Dashboard URL      : ${dashboardUrl}`);
  console.log(`[host] SOCKS5 Endpoint    : ${socksProxyEndpoint}`);
  console.log(`[host] Auth Mode          : none (Chrome does not support SOCKSv5 auth)`);
  console.log(`[host]`);
  console.log(`[host] Configure Chrome to use a SOCKS5 proxy at ${socksProxyEndpoint}`);
  console.log(`[host] Recommended macOS launch command:`);
  console.log(`[host]   ${chromeLaunchCommand}`);

  const payload = {
    sandboxID: sandbox.id,
    dashboardUrl,
    proxyScheme: 'socks5',
    authMode: 'none',
    socksProxyEndpoint,
    socksProxyHost,
    socksProxyPort,
    chromeLaunchCommand
  };

  const deploymentPath = path.join(__dirname, 'burner-vpn-deployment.json');
  await writeFile(deploymentPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`[host] Deployment info written to ${deploymentPath}`);
}

main().catch((err) => {
  console.error(`[host] ❌ Fatal error:`, err.message);
  console.error(`[host]   Stack:`, err.stack);
  process.exit(1);
});
