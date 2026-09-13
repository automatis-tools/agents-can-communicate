import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

const captured = process.platform === "darwin" && process.arch === "arm64";
const quoted = value => `'${String(value).replaceAll("'", "'\\\"'\\\"'")}'`;

test("packed install successfully prepares and verifies a supported Codex service", {
  skip: !captured,
}, async t => {
  const p = await createPackedAcc(t);
  const codexHome = path.join(p.clientHome, ".codex");
  const managedDir = path.join(codexHome, "packages", "standalone", "current", "bin");
  const managed = path.join(managedDir, "codex");
  const socketPath = path.join(codexHome, "app-server-control", "app-server-control.sock");
  const pidPath = path.join(codexHome, "app-server-daemon", "app-server.pid");
  const readyPath = path.join(p.root, "daemon-ready");
  const versionPath = path.join(p.root, "daemon-version.json");
  const commandLog = path.join(p.root, "codex-commands.log");
  const daemonLog = path.join(p.root, "daemon.log");
  const helper = pathToFileURL(path.join(p.repo, "tests", "helpers", "codex-daemon.mjs")).href;
  const launcher = path.join(p.root, "codex-daemon-process.mjs");
  await mkdir(managedDir, { recursive: true });
  await mkdir(path.dirname(socketPath), { recursive: true });
  await mkdir(path.dirname(pidPath), { recursive: true });
  await writeFile(launcher, `
    import { execFile } from "node:child_process";
    import { writeFile } from "node:fs/promises";
    import { promisify } from "node:util";
    import { startCodexDaemonServer } from ${JSON.stringify(helper)};
    const [socketPath, pidPath, managedPath, cwd, readyPath] = process.argv.slice(2);
    process.title = managedPath + " app-server --listen unix://";
    const daemon = await startCodexDaemonServer({ socketPath, cwd, version: "0.154.0" });
    daemon.state.loaded = [];
    const ps = await promisify(execFile)("/bin/ps",
      ["-p", String(process.pid), "-o", "lstart="]);
    await writeFile(pidPath, JSON.stringify({ pid: process.pid,
      processStartTime: ps.stdout.trim() }), { mode: 0o600 });
    await writeFile(readyPath, "ready\\n");
    const close = async () => { await daemon.close(); process.exit(0); };
    process.once("SIGTERM", close); process.once("SIGINT", close);
  `);
  await writeFile(versionPath, JSON.stringify({ status: "running", backend: "pid",
    managedCodexPath: managed, socketPath, cliVersion: "0.154.0",
    managedCodexVersion: "0.154.0", appServerVersion: "0.154.0" }));
  const cli = path.join(p.clientBin, "codex");
  await writeFile(cli, `#!/bin/sh
printf '%s\\n' "$*" >> ${quoted(commandLog)}
case "$*" in
  --version) printf 'codex-cli 0.154.0\\n' ;;
  'app-server daemon --help') printf 'Commands:\\n  start Start\\n  stop Stop\\n  version Version\\n' ;;
  'app-server daemon version') /bin/cat ${quoted(versionPath)} ;;
  'app-server daemon start')
    ${quoted(process.execPath)} ${quoted(launcher)} ${quoted(socketPath)} ${quoted(pidPath)} \
      ${quoted(managed)} ${quoted(p.project)} ${quoted(readyPath)} >> ${quoted(daemonLog)} 2>&1 &
    count=0
    while [ ! -f ${quoted(readyPath)} ] && [ "$count" -lt 100 ]; do
      /bin/sleep 0.05; count=$((count + 1))
    done
    [ -f ${quoted(readyPath)} ] ;;
  *) exit 1 ;;
esac
`);
  await chmod(cli, 0o755);
  await symlink(cli, managed);
  p.env.CODEX_HOME = codexHome;
  p.env.SHELL = "/bin/zsh";
  t.after(async () => {
    const pid = await readFile(pidPath, "utf8").then(JSON.parse).then(value => value.pid)
      .catch(() => null);
    if (!Number.isSafeInteger(pid)) return;
    try { process.kill(pid, "SIGTERM"); } catch { return; }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 25));
      try { process.kill(pid, 0); } catch { return; }
    }
    assert.fail(`fixture daemon ${pid} did not exit`);
  });

  const result = await p.acc(["install", "--adapter", "codex", "--delivery", "actionable"]);
  const [operation] = result.operations;
  assert.equal(operation.nativeServiceSetup.state, "ready");
  assert.equal(operation.nativeServiceSetup.started, true);
  assert.equal(operation.nativeServiceSetup.reasonCode, "native_session_unavailable");
  assert.ok(Number.isSafeInteger(operation.nativeServiceSetup.pid));
  assert.match(operation.nativeServiceSetup.diagnostic, /open a new Codex session/);
  assert.doesNotMatch(operation.nativeServiceSetup.diagnostic, /prepare the missing/i);
  const commands = await readFile(commandLog, "utf8");
  assert.match(commands, /app-server daemon start/);
  assert.match(commands, /app-server daemon version/);
  const ownership = JSON.parse(await readFile(path.join(p.dataHome, "acc", "installs.json")));
  assert.deepEqual(ownership.installs[0].deliveryDecision,
    { source: "explicit-option", completeSetup: true });
});
