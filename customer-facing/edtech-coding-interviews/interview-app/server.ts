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
}

const LANGUAGES: Record<string, LanguageConfig> = {
  python: { image: "python:3.11-slim", filename: "main.py", command: "python3 /workspace/main.py" },
  javascript: { image: "node:20-slim", filename: "main.js", command: "node /workspace/main.js" },
  rust: { image: "rust:1.75-slim", filename: "main.rs", command: "cd /workspace && rustc main.rs && ./main" },
  go: { image: "golang:1.21-alpine", filename: "main.go", command: "cd /workspace && go run main.go" },
  cpp: { image: "gcc:13", filename: "main.cpp", command: "cd /workspace && g++ main.cpp -o main && ./main" },
  java: { image: "openjdk:21-slim", filename: "Main.java", command: "cd /workspace && java Main.java" },
  ruby: { image: "ruby:3.2-slim", filename: "main.rb", command: "ruby /workspace/main.rb" },
  php: { image: "php:8.2-cli", filename: "main.php", command: "php /workspace/main.php" },
  bash: { image: "alpine:3.19", filename: "main.sh", command: "sh /workspace/main.sh" },
  perl: { image: "perl:5.38-slim", filename: "main.pl", command: "perl /workspace/main.pl" }
};

app.post('/execute', async (req, res) => {
  const { code, language } = req.body;

  if (!code || !language) {
    return res.status(400).json({ error: 'Code and language are required.' });
  }

  const langConfig = LANGUAGES[language];
  if (!langConfig) {
    return res.status(400).json({ error: `Unsupported language: ${language}` });
  }

  const apiUrl = process.env.SB_API_URL ?? "http://127.0.0.1:21212";
  const patToken = process.env.SB_PAT_TOKEN;

  if (!patToken) {
    return res.status(500).json({ error: 'Server misconfiguration: SB_PAT_TOKEN is missing. Are you running this via the host script?' });
  }

  const client = new MicroVM({ apiUrl, patToken });

  let sandbox;
  try {
    // 1. Create ephemeral sandbox using the requested language image
    sandbox = await client.create({
      image: langConfig.image,
      cpu: 0.5,
      memoryMB: 512,
    });

    // 2. Upload user code to the correct file
    await sandbox.uploadFile(`/workspace/${langConfig.filename}`, code);

    // 3. Execute code safely
    const result = await sandbox.exec(langConfig.command);

    // 4. Return result
    res.json({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMS: result.durationMS,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Execution failed.' });
  } finally {
    // 5. Instantly cleanup
    if (sandbox) {
      await sandbox.destroy().catch(console.error);
    }
  }
});

app.listen(PORT, () => {
  console.log(`Interview App Server listening on port ${PORT}`);
});
