import assert from "node:assert/strict";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { LSOF_CANDIDATES, observeMaintenanceProcess, probeMaintenanceCli, resolveLsof,
  runMaintenanceCommand, socketListedIn, startTimeValid, verifyMaintenanceProcess }
  from "../src/maintenance-host.mjs";
import { maintenanceFixture } from "./maintenance-fixture.mjs";

const unixHost = { skip: process.platform === "win32" && "ps and lsof are Unix tools" };

// macOS keeps lsof in /usr/sbin and Linux in /usr/bin. The service host takes
// the first candidate that is an executable, from a fixed list and never from
// PATH, so a directory an operator can write to cannot supply it.
test("lsof is taken from the first executable candidate, never from PATH", async () => {
  assert.deepEqual(LSOF_CANDIDATES, ["/usr/sbin/lsof", "/usr/bin/lsof"]);
  const executable = present => async file => {
    if (!present.includes(file)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  assert.equal(await resolveLsof({ access: executable(["/usr/sbin/lsof", "/usr/bin/lsof"]) }),
    "/usr/sbin/lsof");
  assert.equal(await resolveLsof({ access: executable(["/usr/bin/lsof"]) }), "/usr/bin/lsof");
  assert.equal(await resolveLsof({ access: executable([]) }), null);
  assert.equal(await resolveLsof({ access: async () => { throw new Error("EACCES"); } }), null);
});

// A prerelease CLI is judged by its release triple, in maintenance as
// everywhere else: 0.155.0-beta.1 has the daemon commands 0.154.0 introduced.
test("a prerelease CLI at or above the maintenance minimum is accepted by its triple", async t => {
  const h = await maintenanceFixture(t);
  const cli = version => async (command, args) => args.join(" ") === "--version"
    ? { status: 0, stdout: `codex-cli ${version}\n`, stderr: "" }
    : { status: 0, stdout: "Commands:\n  start Start\n  stop Stop\n  version Version\n", stderr: "" };
  assert.deepEqual(await probeMaintenanceCli({ options: h.context }, cli("0.155.0-beta.1")),
    { cliPath: h.cliPath, cliVersion: "0.155.0-beta.1" });
  await assert.rejects(probeMaintenanceCli({ options: h.context }, cli("0.153.9-rc.1")),
    { reasonCode: "maintenance_cli_unsupported" });
  await assert.rejects(probeMaintenanceCli({ options: h.context }, cli("development build")),
    { reasonCode: "maintenance_cli_unsupported" });
});

test("a host without lsof fails socket verification closed", async t => {
  const h = await maintenanceFixture(t);
  const snapshot = { ...await h.inspectMaintenance(h.context) };
  const paths = { codexHome: h.codexHome, socketPath: h.socketPath, managedPath: h.managedPath,
    options: h.context };
  await assert.rejects(verifyMaintenanceProcess(snapshot, paths, h.run, { lsof: async () => null }),
    { reasonCode: "daemon_socket_unproven" });
  // The same identity, with lsof where Linux keeps it, verifies.
  const commands = [];
  const run = (command, args, options) => { commands.push(command); return h.run(command, args, options); };
  await verifyMaintenanceProcess(snapshot, paths, run, { lsof: async () => "/usr/bin/lsof" });
  assert.equal(commands.includes("/usr/bin/lsof"), true);
});

// Linux lsof names a Unix socket with its type appended (`/path type=STREAM`,
// measured on the ubuntu CI job); macOS prints the path alone. Both name the
// same socket.
test("lsof's Linux shape, with the socket type appended, proves the socket", async t => {
  const h = await maintenanceFixture(t);
  const snapshot = { ...await h.inspectMaintenance(h.context) };
  const paths = { codexHome: h.codexHome, socketPath: h.socketPath, managedPath: h.managedPath,
    options: h.context };
  const linux = (command, args, options) => command === "/usr/bin/lsof"
    ? { status: 0, stdout: `p${snapshot.pid}\nf7\nn${h.socketPath} type=STREAM\n`, stderr: "" }
    : h.run(command, args, options);
  await verifyMaintenanceProcess(snapshot, paths, linux, { lsof: async () => "/usr/bin/lsof" });
  assert.equal(socketListedIn(`n${h.socketPath} type=STREAM\n`, h.socketPath), true);
  assert.equal(socketListedIn(`n${h.socketPath}\n`, h.socketPath), true);
  assert.equal(socketListedIn(`n${h.socketPath}-other type=STREAM\n`, h.socketPath), false);
  assert.equal(socketListedIn(`n${path.dirname(h.socketPath)} type=STREAM\n`, h.socketPath), false);
});

// Measured on the host this runs on, so the ubuntu job of the CI matrix
// measures Linux: /bin/ps prints this process's start time in the 24-character
// form the host parses, and lsof resolves to a real executable or to nothing.
// Never skipped: a host without lsof is a measurement too.
test("the real ps and lsof of this host answer in the shapes the service host expects", unixHost,
  async () => {
    const observed = await observeMaintenanceProcess(process.pid, { options: { env: process.env } },
      runMaintenanceCommand);
    assert.equal(observed.state, "alive", JSON.stringify(observed));
    assert.equal(startTimeValid(observed.processStartTime), true, observed.processStartTime);
    assert.equal(path.basename(observed.command.split(" ")[0]).startsWith("node"), true, observed.command);
    const lsof = await resolveLsof({ access });
    if (lsof === null) {
      for (const candidate of LSOF_CANDIDATES) {
        await assert.rejects(access(candidate), `${candidate} exists, so resolution must not report absence`);
      }
    } else {
      assert.equal(LSOF_CANDIDATES.includes(lsof), true, lsof);
      await access(lsof);
    }
    console.log(`maintenance host on ${process.platform}-${process.arch}: lsof ${lsof ?? "absent"}`);
    if (lsof === null) return;
    // A socket this process listens on must be found in the real lsof output,
    // in whatever shape this host's lsof prints it.
    const root = await realpath(await mkdtemp("/tmp/acc-lsof-"));
    const socketPath = path.join(root, "s.sock");
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    try {
      const listed = await runMaintenanceCommand(lsof, ["-n", "-a", "-p", String(process.pid), "-U", "-Fn"],
        { env: process.env });
      assert.equal(listed.status, 0, listed.stderr);
      assert.equal(socketListedIn(listed.stdout, socketPath), true, listed.stdout);
    } finally {
      await new Promise(resolve => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });
