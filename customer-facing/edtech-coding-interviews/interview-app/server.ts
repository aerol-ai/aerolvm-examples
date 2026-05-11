import express from 'express';
import { MicroVM } from '@aerol-ai/aerolvm-sdk';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;

interface LanguageConfig {
  image: string;
  filename: string;
  command: string;
  env?: Record<string, string>;
}

// Default PATH used by /bin/sh in most images
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

const LANGUAGES: Record<string, LanguageConfig> = {
  python: { image: "python:3.11-slim", filename: "main.py", command: "python3 /workspace/main.py" },
  javascript: { image: "node:20-slim", filename: "main.js", command: "node /workspace/main.js" },
  rust: {
    image: "rust:1.75-slim", filename: "main.rs",
    command: "cd /workspace && rustc main.rs && ./main",
    env: { PATH: `/usr/local/cargo/bin:${DEFAULT_PATH}`, CARGO_HOME: "/usr/local/cargo", RUSTUP_HOME: "/usr/local/rustup" },
  },
  go: {
    image: "golang:1.21-alpine", filename: "main.go",
    command: "cd /workspace && go run main.go",
    env: { PATH: `/usr/local/go/bin:/go/bin:${DEFAULT_PATH}`, GOPATH: "/go" },
  },
  cpp: { image: "gcc:13", filename: "main.cpp", command: "cd /workspace && g++ main.cpp -o main && ./main" },
  java: {
    image: "openjdk:21-slim", filename: "Main.java",
    command: "cd /workspace && java Main.java",
    env: { PATH: `/usr/local/openjdk-21/bin:${DEFAULT_PATH}`, JAVA_HOME: "/usr/local/openjdk-21" },
  },
  ruby: { image: "ruby:3.2-slim", filename: "main.rb", command: "ruby /workspace/main.rb" },
  php: { image: "php:8.2-cli", filename: "main.php", command: "php /workspace/main.php" },
  bash: { image: "alpine:3.19", filename: "main.sh", command: "sh /workspace/main.sh" },
  perl: { image: "perl:5.38-slim", filename: "main.pl", command: "perl /workspace/main.pl" }
};

app.post('/execute', async (req, res) => {
  const { code, language } = req.body;
  const reqId = Date.now().toString(36); // short request ID for correlating logs

  console.log(`\n[${reqId}] ========== POST /execute ==========`);
  console.log(`[${reqId}] language=${language}, code length=${code?.length ?? 0}`);

  if (!code || !language) {
    console.log(`[${reqId}] ❌ Missing code or language`);
    return res.status(400).json({ error: 'Code and language are required.' });
  }

  const langConfig = LANGUAGES[language];
  if (!langConfig) {
    console.log(`[${reqId}] ❌ Unsupported language: ${language}`);
    return res.status(400).json({ error: `Unsupported language: ${language}` });
  }

  console.log(`[${reqId}] Language config: image=${langConfig.image}, filename=${langConfig.filename}`);
  console.log(`[${reqId}] Command: ${langConfig.command}`);
  if (langConfig.env) {
    console.log(`[${reqId}] Exec env overrides: ${JSON.stringify(langConfig.env)}`);
  }

  const apiUrl = process.env.SB_API_URL ?? "http://127.0.0.1:21212";
  const patToken = process.env.SB_PAT_TOKEN;

  console.log(`[${reqId}] SB_API_URL = ${apiUrl}`);
  console.log(`[${reqId}] SB_PAT_TOKEN = ${patToken ? '***set***' : '(NOT SET)'}`);

  if (!patToken) {
    console.log(`[${reqId}] ❌ SB_PAT_TOKEN is missing`);
    return res.status(500).json({ error: 'Server misconfiguration: SB_PAT_TOKEN is missing. Are you running this via the host script?' });
  }

  console.log(`[${reqId}] Creating MicroVM client with apiUrl=${apiUrl}`);
  const client = new MicroVM({ apiUrl, patToken });

  let sandbox;
  try {
    // 1. Create ephemeral sandbox using the requested language image
    console.log(`[${reqId}] [step 1/5] Creating ephemeral sandbox with image=${langConfig.image}, cpu=0.5, memoryMB=512...`);
    const createStart = Date.now();
    sandbox = await client.create({
      image: langConfig.image,
      cpu: 0.5,
      memoryMB: 512,
    });
    console.log(`[${reqId}] [step 1/5] ✅ Sandbox created! id=${sandbox.id} (took ${Date.now() - createStart}ms)`);

    // 2. Upload user code to the correct file
    const uploadPath = `/workspace/${langConfig.filename}`;
    console.log(`[${reqId}] [step 2/5] Uploading code to ${uploadPath} (${code.length} bytes)...`);
    const uploadStart = Date.now();
    await sandbox.uploadFile(uploadPath, code);
    console.log(`[${reqId}] [step 2/5] ✅ Upload done (took ${Date.now() - uploadStart}ms)`);

    // 3. Execute code safely
    console.log(`[${reqId}] [step 3/5] Executing: ${langConfig.command}`);
    const execStart = Date.now();
    const result = await sandbox.exec({ command: langConfig.command, env: langConfig.env });
    console.log(`[${reqId}] [step 3/5] ✅ Exec done (took ${Date.now() - execStart}ms)`);
    console.log(`[${reqId}] [step 3/5]   exitCode=${result.exitCode}, durationMS=${result.durationMS}`);
    console.log(`[${reqId}] [step 3/5]   stdout=${JSON.stringify(result.stdout?.substring(0, 500))}`);
    console.log(`[${reqId}] [step 3/5]   stderr=${JSON.stringify(result.stderr?.substring(0, 500))}`);

    // 4. Return result
    console.log(`[${reqId}] [step 4/5] Sending response to client`);
    res.json({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMS: result.durationMS,
    });
  } catch (error: any) {
    console.error(`[${reqId}] ❌ EXCEPTION in /execute handler:`);
    console.error(`[${reqId}]   message: ${error.message}`);
    console.error(`[${reqId}]   stack: ${error.stack}`);
    res.status(500).json({ error: error.message || 'Execution failed.' });
  } finally {
    // 5. Instantly cleanup
    if (sandbox) {
      console.log(`[${reqId}] [step 5/5] Destroying sandbox ${sandbox.id}...`);
      await sandbox.destroy().catch((err: any) => {
        console.error(`[${reqId}] [step 5/5] ⚠️ Destroy failed: ${err.message}`);
      });
      console.log(`[${reqId}] [step 5/5] ✅ Sandbox destroyed`);
    } else {
      console.log(`[${reqId}] [step 5/5] No sandbox to destroy (creation must have failed)`);
    }
    console.log(`[${reqId}] ========== END /execute ==========\n`);
  }
});

app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`Interview App Server listening on port ${PORT}`);
  console.log(`  __dirname     = ${__dirname}`);
  console.log(`  static path   = ${path.join(__dirname, '..', 'public')}`);
  console.log(`  SB_API_URL    = ${process.env.SB_API_URL ?? '(not set, default: http://127.0.0.1:21212)'}`);
  console.log(`  SB_PAT_TOKEN  = ${process.env.SB_PAT_TOKEN ? '***set***' : '(NOT SET)'}`);
  console.log(`========================================\n`);
});
