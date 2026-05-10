import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { MicroVM } from "@aerol-ai/aerolvm-sdk";

const apiUrl = process.env.SB_API_URL ?? "http://127.0.0.1:21212";
const patToken = process.env.SB_PAT_TOKEN;
const postgresUser = process.env.POSTGRES_USER || 'appuser';
const postgresPassword = process.env.POSTGRES_PASSWORD ?? 'password';
const postgresDB = process.env.POSTGRES_DB ?? "appdb";
const publicAuthUser = process.env.PUBLIC_AUTH_USER ?? postgresUser;
const publicAuthPassword = process.env.PUBLIC_AUTH_PASSWORD ?? postgresPassword;

const postgresPort = 5432;
const adminPort = 3000;
const pgData = "/workspace/postgres/data";

if (!patToken) {
  throw new Error("Set SB_PAT_TOKEN before running this example.");
}

if (!postgresUser || !postgresPassword) {
  throw new Error("Set POSTGRES_USER and POSTGRES_PASSWORD before running this example.");
}

if (!publicAuthUser || !publicAuthPassword) {
  throw new Error(
    "Set PUBLIC_AUTH_USER / PUBLIC_AUTH_PASSWORD or provide POSTGRES_USER / POSTGRES_PASSWORD.",
  );
}

const databaseURL = `postgresql://${encodeURIComponent(postgresUser)}:${encodeURIComponent(postgresPassword)}@127.0.0.1:${postgresPort}/${encodeURIComponent(postgresDB)}`;

const adminServer = `import base64
import json
import os
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATABASE_URL = os.environ["DATABASE_URL"]
AUTH_USER = os.environ["PUBLIC_AUTH_USER"]
AUTH_PASSWORD = os.environ["PUBLIC_AUTH_PASSWORD"]
PORT = int(os.environ.get("PORT", "3000"))


def expected_auth_header() -> str:
    token = base64.b64encode(f"{AUTH_USER}:{AUTH_PASSWORD}".encode("utf-8")).decode("ascii")
    return f"Basic {token}"


def query_database() -> bytes:
    result = subprocess.run(
        [
            "psql",
            DATABASE_URL,
            "-Atqc",
            "select json_build_object('database', current_database(), 'current_user', current_user, 'server_version', current_setting('server_version'), 'now', now())::text;",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip().encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/healthz":
            body = b"ok\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if self.headers.get("Authorization") != expected_auth_header():
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="postgres-admin"')
            self.end_headers()
            return

        try:
            body = query_database()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except subprocess.CalledProcessError as error:
            body = json.dumps(
                {"error": error.stderr.strip() or "psql failed"},
            ).encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:
        return


ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
`;

async function waitForPostgres(sandbox: Awaited<ReturnType<MicroVM["create"]>>) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await sandbox.exec({
      command: 'sh -lc \'pg_isready -h 127.0.0.1 -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB"\'',
      timeoutSeconds: 5,
    });

    if (result.exitCode === 0) {
      return;
    }

    await delay(1000);
  }

  throw new Error("Postgres did not become ready in time.");
}

async function waitForAdmin(sandbox: Awaited<ReturnType<MicroVM["create"]>>) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await sandbox.exec({
      command:
        'python3 -c "import urllib.request; urllib.request.urlopen(\\"http://127.0.0.1:3000/healthz\\").read()"',
      timeoutSeconds: 5,
    });

    if (result.exitCode === 0) {
      return;
    }

    await delay(1000);
  }

  throw new Error("The HTTP admin endpoint did not become ready in time.");
}

async function main() {
  const client = new MicroVM({ apiUrl, patToken });
  const sandbox = await client.create({
    image: "postgres:16-bookworm",
    osUser: "root",
    cpu: 2,
    memoryMB: 2048,
    diskGB: 12,
    env: {
      POSTGRES_DB: postgresDB,
      POSTGRES_USER: postgresUser,
      POSTGRES_PASSWORD: postgresPassword,
      PUBLIC_AUTH_USER: publicAuthUser,
      PUBLIC_AUTH_PASSWORD: publicAuthPassword,
      PGDATA: pgData,
      PORT: String(adminPort),
    },
    lifecycle: {
      stopIfIdleFor: 30 * 60 * 1_000_000_000,
      destroyIfIdleFor: 6 * 60 * 60 * 1_000_000_000,
    },
  });

  console.log(`Sandbox created: ${sandbox.id}`);

  await sandbox.exec({
    command:
      "apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates && rm -rf /var/lib/apt/lists/*",
    timeoutSeconds: 240,
  });

  await sandbox.exec("mkdir -p /workspace/postgres /workspace/admin");
  await sandbox.uploadFile("/workspace/admin/postgres-admin.py", adminServer);

  const postgresSession = await sandbox.createSession({
    name: "postgres",
    command: 'sh -lc \'exec docker-entrypoint.sh postgres -c listen_addresses="*" -p 5432\'',
  });

  await waitForPostgres(sandbox);

  const adminSession = await sandbox.createSession({
    name: "postgres-admin",
    command: "python3 /workspace/admin/postgres-admin.py",
    workDir: "/workspace/admin",
    env: {
      DATABASE_URL: databaseURL,
      POSTGRES_DB: postgresDB,
      POSTGRES_USER: postgresUser,
      POSTGRES_PASSWORD: postgresPassword,
      PUBLIC_AUTH_USER: publicAuthUser,
      PUBLIC_AUTH_PASSWORD: publicAuthPassword,
      PORT: String(adminPort),
    },
  });

  await waitForAdmin(sandbox);
  const adminExposure = await sandbox.exposePort(adminPort);
  const postgresExposure = await sandbox.exposePort(postgresPort, { protocol: "tcp" });

  if (postgresExposure.protocol !== "tcp") {
    throw new Error("expected tcp exposure for Postgres");
  }

  // The "tcp" variant carries host / hostPort directly - no URL parsing needed.
  const publicDatabaseURL = `postgresql://${encodeURIComponent(postgresUser)}:${encodeURIComponent(postgresPassword)}@${postgresExposure.host}:${postgresExposure.hostPort}/${encodeURIComponent(postgresDB)}`;

  const payload = {
    sandboxID: sandbox.id,
    postgresSessionID: postgresSession.id,
    adminSessionID: adminSession.id,
    adminURL: adminExposure.url,
    postgresURL: publicDatabaseURL,
    postgresTCP: postgresExposure.url,
    database: {
      hostInsideSandbox: "127.0.0.1",
      port: postgresPort,
      name: postgresDB,
      userEnv: "POSTGRES_USER",
      passwordEnv: "POSTGRES_PASSWORD",
    },
    note: "postgresURL is a native Postgres DSN backed by a caddy-l4 TCP route.",
  };

  await writeFile("deploy-your-own-postgres.json", `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});