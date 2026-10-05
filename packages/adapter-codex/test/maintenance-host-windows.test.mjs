import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { approvedProcessIsDead, readMaintenancePid, startTimeValid, verifyMaintenanceProcess }
  from "../src/maintenance-host.mjs";

// Measured on windows-latest with Codex 0.159.3 under a standard user:
// - daemon.pid is {"pid","processStartTime" (a FILETIME string),"executableIdentity"};
// - WMI gives the same creation time to the microsecond (…050 against …051);
// - the command line is `"\\?\<CODEX_HOME>\packages\app-server-daemon\releases\
//   0.159.3-x86_64-pc-windows-msvc\bin\codex.exe" app-server --listen unix://
//   --managed-daemon`, and `current` leads to that release;
// - Node's lstat refuses the AF_UNIX socket file, which its directory lists.
const STARTED = "134353058576369051";

async function daemonHome(t) {
  const codexHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-cx-mh-")));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const packageDir = path.join(codexHome, "packages", "app-server-daemon");
  const release = path.join(packageDir, "releases", "0.159.3-x86_64-pc-windows-msvc");
  await mkdir(path.join(release, "bin"), { recursive: true });
  await writeFile(path.join(release, "bin", "codex.exe"), "");
  await symlink(release, path.join(packageDir, "current"));
  await mkdir(path.join(codexHome, "app-server-control"));
  await writeFile(path.join(codexHome, "app-server-control", "app-server-control.sock"), "");
  const paths = { platform: "win32-x64", codexHome, packageDir,
    managedPath: path.join(packageDir, "current", "bin", "codex.exe"),
    socketPath: path.join(codexHome, "app-server-control", "app-server-control.sock"), options: {} };
  const command = `"\\\\?\\${path.join(release, "bin", "codex.exe")}" app-server --listen unix:// --managed-daemon`;
  return { paths, command };
}

const seeing = ({ start = "134353058576369050", cmd, alive = true } = {}) => ({
  readProcess: async pid => ({ pid, ppid: 4188, name: "codex.exe", start, cmd }),
  alive: () => alive });

test("windows: a FILETIME is a process start time", () => {
  assert.equal(startTimeValid(STARTED), true);
  assert.equal(startTimeValid("Wed Oct  1 05:24:17 2026"), true);
  assert.equal(startTimeValid("1343530585763690510000"), false);
});

test("windows: the daemon is the managed codex.exe that started when its record says", async t => {
  const { paths, command } = await daemonHome(t);
  const snapshot = { pid: 3592, processStartTime: STARTED };
  await verifyMaintenanceProcess(snapshot, paths, null, { system: seeing({ cmd: command }) });
  await assert.rejects(verifyMaintenanceProcess(snapshot, paths, null,
    { system: seeing({ cmd: command, start: "134353058576369150" }) }), { reasonCode: "daemon_identity_unavailable" });
  await assert.rejects(verifyMaintenanceProcess(snapshot, paths, null,
    { system: seeing({ cmd: '"C:\\elsewhere\\codex.exe" app-server --listen unix:// --managed-daemon' }) }),
  { reasonCode: "daemon_identity_unavailable" });
  await rm(paths.socketPath);
  await assert.rejects(verifyMaintenanceProcess(snapshot, paths, null, { system: seeing({ cmd: command }) }),
    { reasonCode: "daemon_socket_unproven" });
});

test("windows: a process is dead when the pid is gone or started at another time", async t => {
  const { paths, command } = await daemonHome(t);
  const expected = { pid: 3592, processStartTime: STARTED };
  assert.equal(await approvedProcessIsDead(expected, paths, null,
    { system: seeing({ cmd: command, alive: false }) }), true);
  assert.equal(await approvedProcessIsDead(expected, paths, null,
    { system: seeing({ cmd: command, start: "134353058599999990" }) }), true);
  assert.equal(await approvedProcessIsDead(expected, paths, null, { system: seeing({ cmd: command }) }), false);
});

test("windows: the pid record is read where every file reports mode 0o666", async t => {
  const { paths } = await daemonHome(t);
  const file = path.join(paths.codexHome, "daemon.pid");
  await writeFile(file, JSON.stringify({ pid: 3592, processStartTime: STARTED,
    executableIdentity: { digest: [1, 2, 3] } }));
  await chmod(file, 0o666);
  assert.deepEqual(await readMaintenancePid(file, { platform: "win32-x64" }),
    { pid: 3592, processStartTime: STARTED });
});
