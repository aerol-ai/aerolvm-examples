import { MicroVM } from "@aerol-ai/aerolvm-sdk";
import { writeFile } from "node:fs/promises";

const apiUrl = process.env.SB_API_URL ?? "http://127.0.0.1:21212";
const patToken = process.env.SB_PAT_TOKEN;

if (!patToken) {
  throw new Error("Set SB_PAT_TOKEN before running this example.");
}

const probePython = `import json
import subprocess

# Same checks as the Docker probe so the two result files can be diffed
# side-by-side. Under gVisor every kernel-exposure check should return either
# empty output or a synthetic value — the Sentry user-space kernel never
# forwards these reads to the real host kernel, so the host's identity,
# hardware layout, and memory topology remain invisible to sandbox code.
checks = [
    ("capabilities",          "sh -lc 'grep ^CapEff: /proc/self/status'"),
    ("kernel_version",        "uname -r"),
    ("kernel_build",          "cat /proc/version"),
    ("physical_memory_buddy", "cat /proc/buddyinfo"),
    ("hardware_io_regions",   "cat /proc/iomem"),
    ("net_stats",             "cat /proc/net/sockstat"),
]

results = []
for name, command in checks:
    completed = subprocess.run(command, shell=True, capture_output=True, text=True)
    results.append(
        {
            "check": name,
            "command": command,
            "exitCode": completed.returncode,
            "stdout": completed.stdout.strip(),
            "stderr": completed.stderr.strip(),
        }
    )

payload = {"runtime": "gvisor", "results": results}

with open("/workspace/run/probe-report.json", "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2)

print(json.dumps(payload, indent=2))
`;

async function main() {
  const client = new MicroVM({ apiUrl, patToken });
  const sandbox = await client.create({
    image: "python:3.12-bookworm",
    runtime: "gvisor",
    networkBlockAll: true,
    cpu: 0.25,
    memoryMB: 256,
    diskGB: 4,
  });

  try {
    await sandbox.exec("mkdir -p /workspace/run");
    await sandbox.uploadFile("/workspace/run/probe.py", probePython);

    const result = await sandbox.exec({
      command: "python /workspace/run/probe.py",
      timeoutSeconds: 10,
    });

    const report = new TextDecoder().decode(
      await sandbox.downloadFile("/workspace/run/probe-report.json"),
    );

    const payload = {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      report: JSON.parse(report),
    };

    await writeFile(
      "gvisor-kernel-probe-result.json",
      `${JSON.stringify(payload, null, 2)}\n`,
    );

    console.log(JSON.stringify(payload, null, 2));
  } finally {
    await sandbox.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});