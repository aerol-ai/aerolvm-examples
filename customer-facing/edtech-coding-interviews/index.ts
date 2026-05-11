import { MicroVM } from '@aerol-ai/aerolvm-sdk';
import * as dotenv from 'dotenv';
import { writeFile } from 'fs/promises';
import { setTimeout as delay } from 'timers/promises';

dotenv.config();

const patToken = process.env.SB_PAT_TOKEN;
const apiUrl = process.env.SB_API_URL ?? "http://127.0.0.1:21212";
const imageName = process.env.IMAGE_NAME ?? 'ghcr.io/aerol-ai/aerolvm-examples-interview-app:latest';

if (!patToken) {
  console.error("Error: SB_PAT_TOKEN is not set in the environment.");
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
      console.log(`  ${label}: attempt ${i + 1}/${attempts} failed; retrying in ${wait}ms`);
      await delay(wait);
    }
  }
  throw lastErr;
}

async function main() {
  console.log(`Starting Interview App Sandbox using image: ${imageName}...`);
  const client = new MicroVM({ apiUrl, patToken });

  const sandbox = await client.create({
    image: imageName,
    cpu: 1,
    memoryMB: 1024,
    env: {
      SB_PAT_TOKEN: patToken,
      SB_API_URL: apiUrl,
      PORT: "3000"
    }
  });

  console.log(`Sandbox created successfully! ID: ${sandbox.id}`);

  console.log(`Waiting for Interview App server to be ready on port 3000...`);
  // Simple check to see if the port is responding
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await sandbox.exec({
      command: 'curl -s http://127.0.0.1:3000 > /dev/null',
      timeoutSeconds: 5,
    });

    if (result.exitCode === 0) {
      console.log(`Interview App server is ready!`);
      break;
    }
    await delay(1000);
  }

  console.log(`Exposing port 3000...`);
  const exposure = await withRetry("exposePort(3000)", () => sandbox.exposePort(3000));
  
  console.log(`\n✅ Interview App is live at: ${exposure.url}`);
  console.log(`(This app is running entirely within an AerolVM sandbox!)`);
  
  const payload = {
    sandboxID: sandbox.id,
    appUrl: exposure.url,
  };

  await writeFile("interview-app-deployment.json", `${JSON.stringify(payload, null, 2)}\n`);
}

main().catch(console.error);
