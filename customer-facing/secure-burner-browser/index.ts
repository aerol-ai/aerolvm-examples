import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { MicroVM } from "@aerol-ai/aerolvm-sdk";

type RuntimeValue = "docker" | "gvisor" | "kata";
type SandboxHandle = Awaited<ReturnType<MicroVM["create"]>>;

const apiUrl = process.env.SB_API_URL ?? "http://127.0.0.1:21212";
const patToken = process.env.SB_PAT_TOKEN;
const image = process.env.SANDBOX_IMAGE ?? "debian:bookworm";
const runtime = parseRuntime(process.env.SANDBOX_RUNTIME ?? "docker");
const startURL = process.env.START_URL ?? "https://example.com";
const port = parsePort(process.env.NOVNC_PORT ?? "6080");
const workDir = "/workspace/browser-isolation";
const keepAliveCommand = ["sh", "-lc", "trap : TERM INT; while true; do sleep 3600; done"];

if (!patToken) {
  throw new Error("Set SB_PAT_TOKEN before running this example.");
}

function printChunk(chunk: Uint8Array) {
  const text = Buffer.from(chunk).toString("utf8").trimEnd();
  if (text) {
    console.log(text);
  }
}

async function runCommand(
  sandbox: SandboxHandle,
  command: string,
  workdir?: string,
  env?: Record<string, string>,
) {
  console.log(`Running: ${command}`);

  const handle = sandbox.execStream({
    command,
    workdir,
    env,
    onStdout: (chunk) => printChunk(chunk),
    onStderr: (chunk) => printChunk(chunk),
    onError: (message) => console.log(message),
  });

  const exit = await handle.done;
  console.log(`Command exited with code ${exit.code}${exit.signal ? ` (${exit.signal})` : ""}`);

  if (exit.code !== 0) {
    throw new Error(`Command failed: ${command}`);
  }
}

async function waitForShell(sandbox: SandboxHandle) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await sandbox.exec({
      command: "printf ready",
      timeoutSeconds: 5,
    });

    if (result.exitCode === 0 && result.stdout === "ready") {
      return;
    }

    await delay(1000);
  }

  throw new Error("Sandbox shell did not become ready in time.");
}

async function waitForHTTP(url: string, timeoutMS: number) {
  const deadline = Date.now() + timeoutMS;
  let lastError = "request did not succeed";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await delay(1000);
  }

  throw new Error(`Request to ${url} did not succeed in time: ${lastError}`);
}

function serviceURL(baseURL: string, relativePath: string) {
  const normalized = baseURL.endsWith("/") ? baseURL : `${baseURL}/`;
  return new URL(relativePath, normalized).toString();
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function parsePort(value: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("NOVNC_PORT must be an integer between 1 and 65535.");
  }
  return parsed;
}

function parseRuntime(value: string): RuntimeValue {
  if (value === "docker" || value === "gvisor" || value === "kata") {
    return value;
  }
  throw new Error("SANDBOX_RUNTIME must be one of docker, gvisor, kata.");
}

function buildBootstrapScript() {
  const runScriptPath = `${workDir}/run-browser-isolation.sh`;

  return [
    "#!/bin/sh",
    "set -eu",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update",
    "apt-get install -y --no-install-recommends \\",
    "  ca-certificates \\",
    "  chromium \\",
    "  novnc \\",
    "  openbox \\",
    "  websockify \\",
    "  x11-utils \\",
    "  x11vnc \\",
    "  xvfb",
    "rm -rf /var/lib/apt/lists/*",
    `mkdir -p ${shellQuote(workDir)}/logs ${shellQuote(workDir)}/profile`,
    `cat > ${shellQuote(runScriptPath)} <<'EOF'`,
    buildRunScript(),
    "EOF",
    `chmod +x ${shellQuote(runScriptPath)}`,
    "echo 'browser isolation bootstrap complete'",
    "",
  ].join("\n");
}

function buildRunScript() {
  return [
    "#!/bin/sh",
    "set -eu",
    `WORKDIR=${shellQuote(workDir)}`,
    "PORT=\"${NOVNC_PORT:-6080}\"",
    "DISPLAY_NUM=\"${DISPLAY_NUM:-99}\"",
    "SCREEN_GEOMETRY=\"${SCREEN_GEOMETRY:-1440x900x24}\"",
    "WINDOW_SIZE=\"${WINDOW_SIZE:-1440,900}\"",
    "START_URL=\"${START_URL:-about:blank}\"",
    "export DISPLAY=\":${DISPLAY_NUM}\"",
    "LOGDIR=\"${WORKDIR}/logs\"",
    "PROFILE_DIR=\"${WORKDIR}/profile\"",
    "mkdir -p \"${LOGDIR}\" \"${PROFILE_DIR}\"",
    "",
    "cleanup() {",
    "  kill \"${WEBSOCKIFY_PID:-}\" \"${X11VNC_PID:-}\" \"${CHROMIUM_PID:-}\" \"${OPENBOX_PID:-}\" \"${XVFB_PID:-}\" 2>/dev/null || true",
    "}",
    "trap cleanup EXIT INT TERM",
    "",
    "Xvfb \"${DISPLAY}\" -screen 0 \"${SCREEN_GEOMETRY}\" >\"${LOGDIR}/xvfb.log\" 2>&1 &",
    "XVFB_PID=$!",
    "",
    "for _ in $(seq 1 30); do",
    "  if xdpyinfo -display \"${DISPLAY}\" >/dev/null 2>&1; then",
    "    break",
    "  fi",
    "  sleep 1",
    "done",
    "",
    "if ! xdpyinfo -display \"${DISPLAY}\" >/dev/null 2>&1; then",
    "  echo 'Xvfb did not become ready in time' >&2",
    "  exit 1",
    "fi",
    "",
    "openbox >\"${LOGDIR}/openbox.log\" 2>&1 &",
    "OPENBOX_PID=$!",
    "",
    "chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run --no-default-browser-check --user-data-dir=\"${PROFILE_DIR}\" --window-size=\"${WINDOW_SIZE}\" \"${START_URL}\" >\"${LOGDIR}/chromium.log\" 2>&1 &",
    "CHROMIUM_PID=$!",
    "",
    "x11vnc -display \"${DISPLAY}\" -forever -shared -nopw -rfbport 5900 -listen 0.0.0.0 >\"${LOGDIR}/x11vnc.log\" 2>&1 &",
    "X11VNC_PID=$!",
    "",
    "echo \"noVNC listening on http://0.0.0.0:${PORT}/vnc.html\"",
    "websockify --web=/usr/share/novnc/ 0.0.0.0:\"${PORT}\" localhost:5900 >\"${LOGDIR}/websockify.log\" 2>&1 &",
    "WEBSOCKIFY_PID=$!",
    "wait \"${WEBSOCKIFY_PID}\"",
    "",
  ].join("\n");
}

async function main() {
  const client = new MicroVM({ apiUrl, patToken });
  const sandbox = await client.create({
    image,
    runtime,
    osUser: "root",
    cpu: 1,
    memoryMB: 2048,
    diskGB: 8,
    containerCommand: keepAliveCommand,
    lifecycle: {
      stopIfIdleFor: 15 * 60 * 1_000_000_000,
      destroyIfIdleFor: 60 * 60 * 1_000_000_000,
    },
  });

  console.log(`Sandbox created: ${sandbox.id}`);
  console.log(`Sandbox public URL: ${sandbox.publicURL}`);

  await waitForShell(sandbox);
  await sandbox.exec(`mkdir -p ${shellQuote(workDir)}`);
  await sandbox.uploadFile(`${workDir}/bootstrap.sh`, buildBootstrapScript());
  console.log(`Uploaded ${workDir}/bootstrap.sh`);

  await runCommand(
    sandbox,
    `chmod +x ${shellQuote(`${workDir}/bootstrap.sh`)} && ${shellQuote(`${workDir}/bootstrap.sh`)}`,
    workDir,
    { DEBIAN_FRONTEND: "noninteractive" },
  );

  const exposure = await sandbox.exposePort(port);
  const previewURL = serviceURL(exposure.url, "vnc.html?autoconnect=1&resize=remote&reconnect=1");

  console.log(`Reserved noVNC URL: ${previewURL}`);
  console.log("Starting the browser session...");

  const session = await sandbox.createSession({
    name: "secure-burner-browser",
    command: "./run-browser-isolation.sh",
    workDir: workDir,
    env: {
      NOVNC_PORT: String(port),
      START_URL: startURL,
    },
  });

  let ready = false;
  const stream = sandbox.attachSession(session.id, {
    onStdout: (chunk) => printChunk(chunk),
    onStderr: (chunk) => printChunk(chunk),
    onError: (message) => console.log(message),
  });

  const earlyExit = new Promise<never>((_, reject) => {
    void stream.done.then((exit) => {
      if (!ready) {
        reject(new Error(`Browser session exited early with code ${exit.code}${exit.signal ? ` (${exit.signal})` : ""}`));
      }
    }).catch((error) => {
      if (!ready) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });

  try {
    await Promise.race([
      waitForHTTP(previewURL, 60_000).then(() => undefined),
      earlyExit,
    ]);
    ready = true;
  } finally {
    try {
      stream.close();
    } catch {
      // Best-effort detach. The session keeps running after we close the stream.
    }
  }

  const payload = {
    sandboxID: sandbox.id,
    sessionID: session.id,
    previewURL,
    baseURL: exposure.url,
    startURL,
    runtime,
  };

  await writeFile("secure-burner-browser.json", `${JSON.stringify(payload, null, 2)}\n`);
  console.log("Written secure-burner-browser.json");
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});