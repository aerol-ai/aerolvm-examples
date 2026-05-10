import { MicroVM } from "@aerol-ai/aerolvm-sdk";
import { writeFile } from "node:fs/promises";

const apiUrl = process.env.SB_API_URL ?? "http://127.0.0.1:21212";
const patToken = process.env.SB_PAT_TOKEN;

if (!patToken) {
  throw new Error("Set SB_PAT_TOKEN before running this example.");
}

const probePython = `import json
import subprocess

# These checks probe kernel information exposure.
# In a Docker (runc) container the process shares the real host kernel, so
# /proc surfaces the true kernel version, hardware memory layout, and I/O
# regions — everything an attacker needs to fingerprint and target known CVEs.
# Under gVisor the same reads return synthetic data from the Sentry user-space
# kernel: the host kernel version, memory layout, and hardware topology are
# never visible inside the sandbox.
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

payload = {"runtime": "docker", "results": results}

with open("/workspace/run/probe-report.json", "w", encoding="utf-8") as handle:
  json.dump(payload, handle, indent=2)

print(json.dumps(payload, indent=2))
`;

async function main() {
  const client = new MicroVM({ apiUrl, patToken });
  const sandbox = await client.create({
    image: "python:3.12-bookworm",
    runtime: "docker",
    networkBlockAll: true,
    cpu: 0.5,
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
      "docker-kernel-probe-result.json",
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