import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadSessionBinding } from "@agents-can-communicate/adapter-sdk";

import { resolveClient } from "../src/client-pid.mjs";
import { runHook } from "../src/runner.mjs";

// The binary on PATH is not always the program a session runs in. Claude.app
// runs its own claude build; Antigravity 2.0 runs a language server and no agy
// at all; Claude Code updates itself under sessions that keep the old build.
// Measured 2026-10-04: a Claude.app session ran 2.1.286 while PATH said
// 2.1.289, and an Antigravity 2.19.1 session reported agy's 1.2.16.

const SERVER_ARGS = "/Applications/Fixture.app/Contents/Resources/bin/language_server --standalone "
  + "--override_ide_version 2.19.1 --app_data_dir fixture";

const desktopTable = () => new Map([
  [process.pid, { ppid: 4100, comm: "node", args: "node /data/acc-hook.mjs fixture PreInvocation" }],
  [4100, { ppid: 4000, comm: "/Applications/Fixture.app/Contents/Resources/bin/language_server",
    args: SERVER_ARGS }],
  [4000, { ppid: 1, comm: "/Applications/Fixture.app/Contents/MacOS/Fixture", args: "Fixture" }],
]);

const identifyDesktop = entry => (entry.comm.endsWith("/language_server")
  && entry.args.includes("--app_data_dir fixture")
  ? { certificationName: "fixture-desktop", version: "2.19.1" } : null);

const row = (client, version) => ({
  client, version, platform: "darwin-arm64", observedAt: "2026-10-04", capability: "delivery.nextTurn",
  fixture: "fixtures/x.json", provenance: "fixtures/p.json", provenanceId: `${client}-${version}`,
  idleBehavior: "offered", busyBehavior: "waits", authorityLevel: "context", limitations: ["fixture"],
  result: "pass",
});

const adapter = (overrides = {}) => ({
  id: "fixture",
  client: { command: "fixture", certificationName: "fixture-cli", versionArgs: ["--version"],
    variants: [{ certificationName: "fixture-desktop", displayName: "Fixture Desktop" }] },
  capabilities: { delivery: { nextTurn: true } },
  certification: { evidence: [row("fixture-cli", "1.2.0"), row("fixture-desktop", "2.19.1")] },
  normalizeHook: payload => payload,
  injectOutcome: context => ({ stdout: context, stderr: "", exitCode: 0 }),
  renderContext: () => "",
  ...overrides,
});

async function place(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-running-client-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-running-client-data-")));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));
  return { root, dataHome };
}

async function start(t, { fixture = adapter(), table, pathVersion = "1.2.16" }) {
  const { root, dataHome } = await place(t);
  const result = await runHook({
    adapterId: fixture.id, adapters: { [fixture.id]: fixture }, dataHome,
    readProcessTable: async () => table,
    probeClientVersion: async () => pathVersion,
    payload: { kind: "sessionStart", sessionId: "running-client", cwd: root, targets: [] },
  });
  assert.equal(result.failed, undefined, result.reason);
  const workspaces = path.join(dataHome, "acc", "workspaces");
  const [workspace] = await readdir(workspaces);
  const binding = await loadSessionBinding({ runtimeDir: path.join(workspaces, workspace),
    harnessSessionId: "running-client" });
  return { session: result, binding };
}

test("the walk names the product an adapter recognises, with the version it reports", () => {
  const found = resolveClient({ table: desktopTable(), from: process.pid, command: "fixture",
    identify: identifyDesktop });

  assert.equal(found.pid, 4100);
  assert.equal(found.certificationName, "fixture-desktop");
  assert.equal(found.version, "2.19.1");
  assert.equal(found.entry.args, SERVER_ARGS);
});

test("an adapter that recognises nothing still finds its own command", () => {
  const table = new Map([[process.pid, { ppid: 300, comm: "node" }], [300, { ppid: 1, comm: "fixture" }]]);
  const found = resolveClient({ table, from: process.pid, command: "fixture", identify: () => null });

  assert.deepEqual({ pid: found.pid, certificationName: found.certificationName,
    version: found.version }, { pid: 300, certificationName: undefined, version: undefined });
});

test("an identifier that throws is an identifier that recognised nothing", () => {
  const table = new Map([[process.pid, { ppid: 300, comm: "node" }], [300, { ppid: 1, comm: "fixture" }]]);
  const found = resolveClient({ table, from: process.pid, command: "fixture",
    identify: () => { throw new Error("bad entry"); } });

  assert.equal(found.pid, 300);
});

test("a desktop session carries its product and version, not the CLI on PATH", async t => {
  const { session, binding } = await start(t, { fixture: adapter({ identifyClientProcess: identifyDesktop }),
    table: desktopTable() });

  assert.equal(session.clientVersion, "2.19.1");
  assert.equal(session.clientName, "fixture-desktop");
  assert.equal(binding.clientVersion, "2.19.1");
  assert.equal(binding.clientName, "fixture-desktop");
  assert.equal(binding.clientPid, 4100);
  // Judged by the desktop's own capture at 2.19.1, not the CLI's at 1.2.0.
  assert.equal(session.capabilities.delivery.nextTurn, true);
});

test("a product the adapter does not declare is the adapter's own client", async t => {
  const { session, binding } = await start(t, { fixture: adapter({
    identifyClientProcess: entry => (identifyDesktop(entry) === null ? null
      : { certificationName: "fixture-ide", version: "2.19.1" }) }), table: desktopTable() });

  assert.equal(session.clientName, undefined);
  assert.equal(binding.clientName, undefined);
});

test("an adapter's own reading of the running client beats the PATH probe", async t => {
  const table = new Map([[process.pid, { ppid: 300, comm: "node" }], [300, { ppid: 1, comm: "fixture" }]]);
  const asked = [];
  const { session } = await start(t, { table, pathVersion: "2.1.289", fixture: adapter({
    clientVersionOf: async ({ pid, entry }) => { asked.push([pid, entry.comm]); return "2.1.286"; } }) });

  assert.equal(session.clientVersion, "2.1.286");
  assert.deepEqual(asked, [[300, "fixture"]]);
});

test("a reading that fails or answers nonsense leaves the PATH probe's version", async t => {
  const table = new Map([[process.pid, { ppid: 300, comm: "node" }], [300, { ppid: 1, comm: "fixture" }]]);
  for (const clientVersionOf of [async () => { throw new Error("gone"); }, async () => "latest",
    () => "2.1.286"]) {
    const { session } = await start(t, { table, pathVersion: "2.1.289",
      fixture: adapter({ clientVersionOf }) });
    assert.equal(session.clientVersion, clientVersionOf.constructor.name === "AsyncFunction"
      ? "2.1.289" : "2.1.286");
  }
});

test("a client started by full path answers for itself", { skip: process.platform === "win32" },
  async t => {
    const bin = await realpath(await mkdtemp(path.join(tmpdir(), "acc-own-exe-")));
    t.after(() => rm(bin, { recursive: true, force: true }));
    const executable = path.join(bin, "fixture");
    await writeFile(executable, "#!/bin/sh\necho 'fixture-cli 0.159.2'\n");
    await chmod(executable, 0o755);
    const table = new Map([[process.pid, { ppid: 300, comm: "node" }],
      [300, { ppid: 1, comm: executable, args: `${executable} app-server` }]]);

    const { session } = await start(t, { table, pathVersion: "0.160.0" });

    assert.equal(session.clientVersion, "0.159.2");
  });

// Antigravity 2.0 keeps a conversation across app restarts and runs no
// SessionStart for it again: on 2026-10-05 a reopened app's first turn reached
// the hooks with the binding still naming the language server that had exited,
// so the session stayed bound to a dead pid and live delivery never returned.
test("a turn after the client restarted binds the session to the client running now", async t => {
  const { spawnSync } = await import("node:child_process");
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  const { root, dataHome } = await place(t);
  const fixture = adapter({ identifyClientProcess: identifyDesktop });
  const run = (kind, table) => runHook({ adapterId: fixture.id, adapters: { [fixture.id]: fixture },
    dataHome, readProcessTable: async () => table, probeClientVersion: async () => "1.2.16",
    payload: { kind, sessionId: "restarted-client", cwd: root, targets: [] } });
  const tableWith = pid => new Map([
    [process.pid, { ppid: pid, comm: "node", args: "node /data/acc-hook.mjs fixture PreInvocation" }],
    [pid, { ppid: 1, comm: "/Applications/Fixture.app/Contents/Resources/bin/language_server",
      args: SERVER_ARGS }]]);
  const binding = async () => {
    const workspaces = path.join(dataHome, "acc", "workspaces");
    const [workspace] = await readdir(workspaces);
    return loadSessionBinding({ runtimeDir: path.join(workspaces, workspace), harnessSessionId: "restarted-client" });
  };

  assert.equal((await run("sessionStart", tableWith(gone))).failed, undefined);
  assert.equal((await binding()).clientPid, gone);
  const turn = await run("beforeTurn", tableWith(process.ppid));

  assert.equal(turn.failed, undefined, turn.reason);
  const after = await binding();
  assert.equal(after.clientPid, process.ppid);
  assert.equal(after.clientName, "fixture-desktop");
  assert.equal(after.accSessionId, (await binding()).accSessionId);
});

test("a turn while the client still runs keeps the client the session started with", async t => {
  const { root, dataHome } = await place(t);
  const fixture = adapter({ identifyClientProcess: identifyDesktop });
  let reads = 0;
  const run = kind => runHook({ adapterId: fixture.id, adapters: { [fixture.id]: fixture }, dataHome,
    readProcessTable: async () => { reads += 1; return new Map([
      [process.pid, { ppid: process.ppid, comm: "node" }],
      [process.ppid, { ppid: 1, comm: "/Applications/Fixture.app/Contents/Resources/bin/language_server",
        args: SERVER_ARGS }]]); },
    probeClientVersion: async () => "1.2.16",
    payload: { kind, sessionId: "live-client", cwd: root, targets: [] } });

  await run("sessionStart");
  const before = reads;
  assert.equal((await run("beforeTurn")).failed, undefined);
  assert.equal(reads, before, "a live client is not looked up again on every turn");
});

// Review of #254: a session can also close while its client is down. That
// session resumes on the next turn, bound to the client running now.
test("a turn after the client exited and its session closed resumes it on the client running now",
  async t => {
    const { spawnSync } = await import("node:child_process");
    const gone = spawnSync(process.execPath, ["-e", ""]).pid;
    const { root, dataHome } = await place(t);
    const fixture = adapter({ identifyClientProcess: identifyDesktop });
    const run = (kind, table) => runHook({ adapterId: fixture.id, adapters: { [fixture.id]: fixture },
      dataHome, readProcessTable: async () => table, probeClientVersion: async () => "1.2.16",
      payload: { kind, sessionId: "closed-while-down", cwd: root, targets: [] } });
    const tableWith = pid => new Map([
      [process.pid, { ppid: pid, comm: "node", args: "node /data/acc-hook.mjs fixture PreInvocation" }],
      [pid, { ppid: 1, comm: "/Applications/Fixture.app/Contents/Resources/bin/language_server",
        args: SERVER_ARGS }]]);

    const started = await run("sessionStart", tableWith(gone));
    await started.service.closeSession({ sessionId: started.accSessionId, generation: started.generation });
    const turn = await run("beforeTurn", tableWith(process.ppid));

    assert.equal(turn.failed, undefined, turn.reason);
    const workspaces = path.join(dataHome, "acc", "workspaces");
    const [workspace] = await readdir(workspaces);
    const after = await loadSessionBinding({ runtimeDir: path.join(workspaces, workspace),
      harnessSessionId: "closed-while-down" });
    assert.equal(after.clientPid, process.ppid);
    assert.equal(after.clientName, "fixture-desktop");
  });
