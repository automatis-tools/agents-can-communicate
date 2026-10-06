import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { EXIT } from "@agents-can-communicate/protocol";
import { createPackedAcc } from "../helpers/packed-acc.mjs";
import { createUpdateRegistry } from "../helpers/update-registry.mjs";

async function v6(f) {
  await f.acc(["status"]);
  const workspaces = path.join(f.dataHome, "acc", "workspaces");
  const [id] = await readdir(workspaces);
  const root = path.join(workspaces, id), file = path.join(root, "protocol.json");
  const identity = { ...JSON.parse(await readFile(file)), storeVersion: 6 };
  await writeFile(file, JSON.stringify(identity));
  return { root, file, before: await readFile(file) };
}

test("packed doctor migrates explicitly, preserves message bytes and supports send/retry", async t => {
  const f = await createPackedAcc(t);
  await f.setClientVersions({ claude: "2.1.266" });
  const sender = await f.acc(["attach", "--participant", "sender", "--harness", "cli"]);
  await f.acc(["attach", "--participant", "peer", "--harness", "cli"]);
  const owner = ["--session", sender.sessionId, "--generation", sender.generation];
  const old = await f.acc(["message", "--to", "peer", "--subject", "Before", "--body", "Preserve these bytes",
    "--client-message-id", "client_before", ...owner]);
  const state = await v6(f);
  const messageFile = path.join(state.root, "state/message", old.message.messageId + ".json");
  const beforeMessage = await readFile(messageFile);
  assert.equal((await f.accError(["doctor", "--repair"])).code, EXIT.DATA);
  assert.deepEqual(await readFile(state.file), state.before);
  const hook = await f.hook("claude_code", { hook_event_name: "SessionStart", session_id: "unmigrated_fixture",
    cwd: f.project, source: "startup" }, { ACC_PARTICIPANT: "unmigrated_client" });
  assert.match(hook.stderr, /doctor --migrate-store/);
  assert.deepEqual(await readFile(state.file), state.before, "a hook must not migrate automatically");
  const migrated = await f.acc(["doctor", "--migrate-store"]);
  assert.deepEqual([migrated.fromVersion, migrated.toVersion, migrated.migrated], [6, 7, true]);
  assert.deepEqual(await readFile(messageFile), beforeMessage);
  const args = ["message", "--to", "peer", "--subject", "After", "--body", "After explicit migration",
    "--client-message-id", "client_after", ...owner];
  const first = await f.acc(args), retry = await f.acc(args);
  assert.equal(first.message.messageId, retry.message.messageId);
  const changed = [...args]; changed[changed.indexOf("After explicit migration")] = "Different content";
  assert.equal((await f.accError(changed)).code, EXIT.CONFLICT);
});

test("packed verified pending management code migrates only after old native holds exit", async t => {
  const f = await createPackedAcc(t);
  const registry = await createUpdateRegistry(t, f, "0.9.99");
  await f.setClientVersions({ claude: "2.1.266" });
  await f.acc(["install", "--adapter", "claude_code", "--delivery", "off"]);
  await f.acc(["update", "--auto", "off"]);
  const state = await v6(f), bindings = path.join(state.root, "bindings"), hold = path.join(bindings, "native.json");
  await mkdir(bindings, { recursive: true });
  await writeFile(hold, JSON.stringify({ schemaVersion: 1, clientPid: process.pid, storeVersion: 6 }));
  const staged = await f.acc(["update"], { ACC_NO_UPDATE_CHECK: "0", npm_config_registry: registry.url,
    npm_config_cache: path.join(f.root, "update-cache") });
  assert.equal(staged.activated, false, JSON.stringify(staged));
  const manager = path.join(f.dataHome, "acc", "runtime"), controlFile = path.join(manager, "control.json");
  const before = JSON.parse(await readFile(controlFile));
  assert.equal(before.active.version, "0.9.0");
  assert.equal(before.pending.version, "0.9.99");
  const requests = registry.requests.length;
  assert.equal((await f.accError(["doctor", "--migrate-store"])).code, EXIT.CONFLICT);
  assert.deepEqual(await readFile(state.file), state.before);
  await rm(hold);
  const migrated = await f.acc(["doctor", "--migrate-store"]);
  assert.equal(migrated.migrated, true);
  assert.equal(registry.requests.length, requests, "migration must not contact npm");
  const after = JSON.parse(await readFile(controlFile));
  assert.deepEqual(after.active, before.active, "migration must not activate another release");
  assert.deepEqual(after.pending, before.pending);
  assert.equal(JSON.parse(await readFile(state.file)).storeVersion, 7);
});
