import { execSync } from 'child_process';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const patToken = process.env.SB_PAT_TOKEN;
const apiUrl = process.env.SB_API_URL ?? "http://127.0.0.1:21212";

if (!patToken) {
  console.error("Error: SB_PAT_TOKEN is not set in the environment.");
  process.exit(1);
}

const imageName = process.env.IMAGE_NAME ?? 'ghcr.io/aerol-ai/aerolvm-examples-interview-app:latest';

console.log(`Pulling Docker image '${imageName}' from GHCR...`);
try {
  execSync(`docker pull ${imageName}`, { stdio: 'inherit' });
} catch (error) {
  console.error("Failed to pull Docker image. Make sure it is published or you have access.");
  process.exit(1);
}

console.log(`\nStarting Docker container...`);
console.log(`Injecting SB_PAT_TOKEN and SB_API_URL into the container.`);

const dockerRunCommand = [
  'docker run',
  '--rm', // automatically remove container when it exits
  '-p 3000:3000', // expose port
  `-e SB_PAT_TOKEN="${patToken}"`,
  `-e SB_API_URL="${apiUrl}"`,
  imageName
].join(' ');

try {
  console.log(`\n✅ Interview App will be available at: http://localhost:3000`);
  console.log(`Press Ctrl+C to stop.\n`);
  execSync(dockerRunCommand, { stdio: 'inherit' });
} catch (error) {
  console.error("Container stopped or failed.");
}
