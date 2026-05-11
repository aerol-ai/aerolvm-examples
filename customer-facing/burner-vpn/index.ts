import { MicroVM } from '@aerol-ai/aerolvm-sdk';
import * as dotenv from 'dotenv';
import { writeFile } from 'fs/promises';
import { setTimeout as delay } from 'timers/promises';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

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
  const proxyUser = `user_${crypto.randomBytes(4).toString('hex')}`;
  const proxyPass = crypto.randomBytes(8).toString('hex');

  console.log(`[host] Creating MicroVM client with apiUrl=${apiUrl}`);
  const client = new MicroVM({ apiUrl, patToken });

  console.log(`[host] Creating sandbox with image=${imageName}, cpu=1, memoryMB=1024`);
  console.log(`[host] Env vars being passed to sandbox:`);
  console.log(`[host]   PORT         = 3000`);
  console.log(`[host]   PROXY_PORT   = 8080`);
  console.log(`[host]   PROXY_USER   = ${proxyUser}`);
  console.log(`[host]   PROXY_PASS   = ***set***`);

  const createStart = Date.now();
  const sandbox = await client.create({
    image: imageName,
    cpu: 1,
    memoryMB: 1024,
    env: {
      PORT: "3000",
      PROXY_PORT: "8080",
      PROXY_USER: proxyUser,
      PROXY_PASS: proxyPass
    }
  });

  console.log(`[host] ✅ Sandbox created! ID: ${sandbox.id} (took ${Date.now() - createStart}ms)`);

  console.log(`[host] Waiting for Web Dashboard to be ready on port 3000...`);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    console.log(`[host]   Health check attempt ${attempt + 1}/20...`);
    const result = await sandbox.exec({
      command: 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000',
      timeoutSeconds: 5,
    });

    console.log(`[host]   exitCode=${result.exitCode}, stdout=${result.stdout}, stderr=${result.stderr?.substring(0, 200)}`);

    if (result.exitCode === 0) {
      console.log(`[host] ✅ Web Dashboard is ready!`);
      break;
    }
    if (attempt === 19) {
      console.error(`[host] ❌ Server did not become ready after 20 attempts`);
    }
    await delay(1000);
  }

  console.log(`[host] Exposing ports...`);
  const dashboardExposure = await withRetry("exposePort(3000)", () => sandbox.exposePort(3000));
  const proxyExposure = await withRetry("exposePort(8080)", () => sandbox.exposePort(8080, { protocol: "tcp" }));
  
  const cleanProxyUrl = proxyExposure.url.replace('tcp://', '');
  
  console.log(`\n======================================================`);
  console.log(`[host] 🚀 BURNER VPN IS LIVE!`);
  console.log(`======================================================`);
  console.log(`[host] Dashboard URL : ${dashboardExposure.url}`);
  console.log(`[host] Proxy Endpoint: ${cleanProxyUrl}`);
  console.log(`[host] Username      : ${proxyUser}`);
  console.log(`[host] Password      : ${proxyPass}`);
  console.log(`[host] \n(Open the Dashboard URL in your browser to see live traffic!)`);
  
  const payload = {
    sandboxID: sandbox.id,
    dashboardUrl: dashboardExposure.url,
    proxyEndpoint: cleanProxyUrl,
    proxyUser,
    proxyPass
  };

  await writeFile("burner-vpn-deployment.json", `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`[host] Deployment info written to burner-vpn-deployment.json`);
}

main().catch((err) => {
  console.error(`[host] ❌ Fatal error:`, err.message);
  console.error(`[host]   Stack:`, err.stack);
  process.exit(1);
});
