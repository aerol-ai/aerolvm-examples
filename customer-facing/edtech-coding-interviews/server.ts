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
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

app.post('/execute', async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'No code provided.' });
  }

  const apiUrl = process.env.SB_API_URL ?? "http://127.0.0.1:21212";
  const patToken = process.env.SB_PAT_TOKEN;

  if (!patToken) {
    return res.status(500).json({ error: 'Server misconfiguration: SB_PAT_TOKEN is missing.' });
  }

  const client = new MicroVM({ apiUrl, patToken });

  let sandbox;
  try {
    // 1. Create ephemeral sandbox
    sandbox = await client.create({
      image: "python:3.11-slim",
      cpu: 0.5,
      memoryMB: 512,
    });

    // 2. Upload user code
    await sandbox.uploadFile("/workspace/main.py", code);

    // 3. Execute code safely
    const result = await sandbox.exec("python3 /workspace/main.py");

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
  console.log(`Server listening on http://localhost:${PORT}`);
});
