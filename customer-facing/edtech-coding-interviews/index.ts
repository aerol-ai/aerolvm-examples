import { MicroVM } from '@aerol-ai/aerolvm-sdk';
import * as dotenv from 'dotenv';
import { writeFile } from 'fs/promises';
import { setTimeout as delay } from 'timers/promises';

dotenv.config();

const patToken = process.env.SB_PAT_TOKEN;
const apiUrl = process.env.SB_API_URL ?? "http://127.0.0.1:21212";
const imageName = process.env.IMAGE_NAME ?? 'ghcr.io/aerol-ai/aerolvm-examples-interview-app:latest';

console.log(`\n========================================`);
console.log(`[host] Interview App Host Script`);
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
  console.log(`[host] Creating MicroVM client with apiUrl=${apiUrl}`);
  const client = new MicroVM({ apiUrl, patToken });

  console.log(`[host] Creating sandbox with image=${imageName}, cpu=1, memoryMB=1024`);
  console.log(`[host] Env vars being passed to sandbox:`);
  console.log(`[host]   SB_PAT_TOKEN = ***set***`);
  console.log(`[host]   SB_API_URL   = ${apiUrl}`);
  console.log(`[host]   PORT         = 3000`);

  const createStart = Date.now();
  const sandbox = await client.create({
    image: imageName,
    cpu: 1,
    memoryMB: 1024,
    env: {
      SB_PAT_TOKEN: patToken!,
      SB_API_URL: apiUrl,
      PORT: "3000"
    }
  });
  console.log(`[host] ✅ Sandbox created! ID: ${sandbox.id} (took ${Date.now() - createStart}ms)`);

  console.log(`[host] Waiting for Interview App server to be ready on port 3000...`);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    console.log(`[host]   Health check attempt ${attempt + 1}/20...`);
    const result = await sandbox.exec({
      command: 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000',
      timeoutSeconds: 5,
    });
    console.log(`[host]   exitCode=${result.exitCode}, stdout=${result.stdout}, stderr=${result.stderr?.substring(0, 200)}`);

    if (result.exitCode === 0) {
      console.log(`[host] ✅ Interview App server is ready!`);
      break;
    }
    if (attempt === 19) {
      console.error(`[host] ❌ Server did not become ready after 20 attempts`);
    }
    await delay(1000);
  }

  console.log(`[host] Exposing port 3000...`);
  const exposure = await withRetry("exposePort(3000)", () => sandbox.exposePort(3000));

  console.log(`\n[host] ✅ Interview App is live at: ${exposure.url}`);
  console.log(`[host] (This app is running entirely within an AerolVM sandbox!)`);

  const payload = {
    sandboxID: sandbox.id,
    appUrl: exposure.url,
  };

  await writeFile("interview-app-deployment.json", `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`[host] Deployment info written to interview-app-deployment.json`);
}

main().catch((err) => {
  console.error(`[host] ❌ Fatal error:`, err.message);
  console.error(`[host]   Stack:`, err.stack);
  process.exit(1);
});
