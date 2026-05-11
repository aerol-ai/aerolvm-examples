import { MicroVM } from "@aerol-ai/aerolvm-sdk";

const apiUrl = process.env.SB_API_URL ?? "http://127.0.0.1:21212";
const patToken = process.env.SB_PAT_TOKEN;
const jupyterToken = "aerolvm-secret-token"; // Choose a secure token



async function main() {
  if (!patToken) throw new Error("Set SB_PAT_TOKEN.");
  console.log("Initializing AerolVM client...");
  const client = new MicroVM({ apiUrl, patToken });

  console.log("Creating Jupyter sandbox (1 CPU, 2GB RAM)...");
  const sandbox = await client.create({
    image: "python:3.11-bookworm",
    cpu: 1,
    memoryMB: 2048,
  });
  console.log(`Sandbox created successfully! ID: ${sandbox.id}`);

  console.log("Installing JupyterLab and Data Science stack (this may take a minute)...");
  const installRes = await sandbox.exec("pip install jupyterlab pandas matplotlib polars");
  console.log(`Packages installed (exit code: ${installRes.exitCode}, duration: ${installRes.durationMS}ms)`);

  console.log("Starting JupyterLab server session...");
  const session = await sandbox.createSession({
    name: "jupyter-server",
    command: `jupyter lab --ip=0.0.0.0 --port=8888 --no-browser --NotebookApp.token='${jupyterToken}' --allow-root`,
  });
  console.log(`JupyterLab session started! ID: ${session.id}`);

  console.log("Exposing Jupyter port 8888...");
  const exposure = await sandbox.exposePort(8888);
  console.log(`Port exposed successfully!`);

  console.log("\n--- JupyterLab Ready ---");
  console.log(`URL: ${exposure.url}?token=${jupyterToken}`);
  console.log("-------------------------\n");
  
  console.log("The sandbox will stay alive as long as you use the notebook.");
}

main().catch(console.error);
