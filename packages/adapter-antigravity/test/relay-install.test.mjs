import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { doctorAntigravity, installAntigravity, uninstallAntigravity } from "../src/install.mjs";
import { listRegistrations, newRelayId, writeRegistration } from "../src/relay-endpoint.mjs";
import { relayShimPath } from "../src/relays.mjs";
import { fakeAgy } from "./fake-agy.mjs";

const RELAY_BINARY = "/opt/acc/bin/acc-antigravity-relay.mjs";

async function machine(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-agy-relay-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, ".gemini", "config"), { recursive: true });
  const signalled = [];
  const context = { home, dataHome: path.join(home, "acc-data"), runAgy: fakeAgy().run,
    antigravityRelay: RELAY_BINARY,
    antigravityRelayControl: {
      argvOf: async pid => pid === 7001 ? ["node", "/opt/acc/bin/entrypoints/acc-antigravity-relay.mjs", "run"]
        : ["/usr/bin/vim", "notes.txt"],
      kill: (pid, signal) => signalled.push([pid, signal]) } };
  return { home, context, signalled };
}

async function registered(context, workspaceId, relayPid) {
  const runtimeDir = path.join(context.dataHome, "acc", "workspaces", workspaceId);
  await mkdir(runtimeDir, { recursive: true });
  await writeRegistration({ runtimeDir, record: { schemaVersion: 1, endpointId: newRelayId(),
    conversationId: "3ed65ea5-31f2-4ddf-b6c7-e3c85a9a3c29", agyPid: 4242, relayPid,
    socketPath: "/tmp/r0123456789ab.sock", nonce: randomBytes(32).toString("hex"),
    clientVersion: "1.2.7", protocolContract: "antigravity-agentapi-relay-v1",
    modes: ["livePush", "idleWake", "busyQueue"],
    leaseUntil: new Date(Date.now() + 120_000).toISOString() } });
  return runtimeDir;
}

test("install writes the one command the agent runs to start live delivery", async t => {
  const { home, context } = await machine(t);

  await installAntigravity(context);

  const shim = relayShimPath(home);
  assert.equal(shim, path.join(home, ".gemini", "config", "acc", "acc-relay.sh"));
  assert.equal(((await stat(shim)).mode & 0o111) !== 0, true, "the shim is not executable");
  const text = await readFile(shim, "utf8");
  assert.match(text, new RegExp(`ACC_RELAY="${RELAY_BINARY}"`));
  assert.doesNotMatch(text, /exec acc /, "acc start is not a command; the shim must not fall back to it");
  assert.match(text, /exit 0\n$/, "a missing relay is one line, never a failed tool call");
});

test("uninstall stops every relay it started, and never a process that merely reused the pid",
  async t => {
    const { context, signalled } = await machine(t);
    await installAntigravity(context);
    const first = await registered(context, "workspace_a", 7001);
    const second = await registered(context, "workspace_b", 7002);
    const oldLog = path.join(first, "native", "antigravity", `antigravity_relay_${"e".repeat(32)}.log`);
    await writeFile(oldLog, "{}\n", { mode: 0o600 });

    await uninstallAntigravity(context);

    assert.deepEqual(signalled, [[7001, "SIGTERM"]]);
    assert.deepEqual(await listRegistrations({ runtimeDir: first }), []);
    assert.deepEqual(await listRegistrations({ runtimeDir: second }), []);
    assert.equal(await stat(oldLog).then(() => true, () => false), false,
      "a relay log outlived the uninstall");
  });

test("doctor says how live delivery starts, and how many relays run", async t => {
  const { context } = await machine(t);
  await installAntigravity(context);
  await registered(context, "workspace_a", process.pid);

  const { diagnostics } = await doctorAntigravity(context);

  assert.equal(diagnostics.some(line => /live delivery starts when the agent runs .*acc-relay\.sh.* start/.test(line)), true);
  assert.equal(diagnostics.includes("antigravity relays running on this machine: 1"), true);
});
