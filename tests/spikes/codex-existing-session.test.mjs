import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const captureScript = path.join(repoRoot, "scripts", "spikes", "codex-existing-session.mjs");

for (const userAgent of [
  "codex_app_server/0.152.0-beta.1",
  "codex_app_server/0.152.0.1",
]) {
  test(`the Codex capture rejects non-exact app-server version ${userAgent}`, async () => {
    const fixture = await startFixture(userAgent);
    try {
      const result = await runCapture(fixture);
      assert.equal(result.code, 0, result.stderr);
      const capture = JSON.parse(result.stdout);
      assert.equal(capture.result, "fail");
      assert.equal(
        capture.limitations[0],
        "running app-server version did not match codex-cli 0.152.0",
      );
    } finally {
      await fixture.close();
    }
  });
}

async function startFixture(userAgent) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "acc-codex-spike-"));
  const socketPath = path.join(tempDir, "control.sock");
  const command = path.join(tempDir, "fake-codex.mjs");
  writeFileSync(command, `#!/usr/bin/env node
import readline from "node:readline";
if (process.argv[2] === "--version") {
  process.stdout.write("codex-cli 0.152.0\\n");
  process.exit(0);
}
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  const result = message.method === "initialize"
    ? { userAgent: process.env.FAKE_CODEX_USER_AGENT }
    : { data: [] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
});
`, { mode: 0o700 });
  chmodSync(command, 0o700);
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    command,
    socketPath,
    userAgent,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function runCapture(fixture) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [captureScript, "--thread", "thread_existing", "--message", "message_1",
        "--cwd", repoRoot],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          ACC_CODEX_SPIKE_COMMAND: fixture.command,
          ACC_CODEX_APP_SERVER_SOCKET: fixture.socketPath,
          FAKE_CODEX_USER_AGENT: fixture.userAgent,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
