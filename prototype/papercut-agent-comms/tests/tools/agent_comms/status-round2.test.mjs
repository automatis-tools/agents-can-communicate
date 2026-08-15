import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { writeJsonAtomic } from "../../../tools/agents/lib/atomic-json.mjs";
import { sendMessage } from "../../../tools/agents/lib/messages.mjs";
import { validateProtocol } from "../../../tools/agents/lib/schema.mjs";
import { collectStatus, runDoctor } from "../../../tools/agents/lib/status.mjs";
import { createBusFixture, messageRequest, pathExists, seedAcknowledgement,
  seedOpenAgent } from "./helpers.mjs";

async function setup(t) {
  const fixture = await createBusFixture(); t.after(fixture.cleanup);
  const context = { ...fixture.context, pid: 4242, pidIsAlive: pid => pid === 4242,
    randomUUID: () => "22222222-2222-4222-8222-222222222222",
    listActiveAgentIds: async () => ["visual", "models"] };
  await Promise.all(["visual", "models"].map(agentId => seedOpenAgent(context,
    { agentId, task: "M2.7" })));
  const protocol = validateProtocol({ schema_version: 1, protocol_version: 1,
    checkout_id: "c".repeat(64), checkout_root: fixture.root,
    initialized_at: context.now().toISOString() });
  await writeJsonAtomic(context.paths.protocol, protocol,
    { tmpDir: context.paths.tmp, exclusive: true });
  return { ...fixture, context };
}

test("unknown schema version blocks all repair mutation", async t => {
  const { context } = await setup(t);
  const unknown = { schema_version: 2, protocol_version: 1, checkout_id: "c".repeat(64),
    checkout_root: path.dirname(context.paths.root), initialized_at: context.now().toISOString() };
  const bytes = `${JSON.stringify(unknown)}\n`;
  await writeFile(context.paths.protocol, bytes);
  const message = await sendMessage(context, messageRequest());
  await seedAcknowledgement(context, message);
  const report = await runDoctor(context, { repair: true });
  assert.equal(report.ok, false);
  assert.equal(report.issues.some(item => item.code === "UNKNOWN_SCHEMA_VERSION"), true);
  assert.equal(await readFile(context.paths.protocol, "utf8"), bytes);
  assert.equal(await pathExists(context.paths.inboxFile("models", message.id)), true);
});

test("doctor audit rejects a canonical quarantine symlink before following it", async t => {
  const { context, root } = await setup(t);
  const source = context.paths.inboxFile("models", "broken");
  const bytes = Buffer.from("outside secret");
  const digest = createHash("sha256").update(source).update(bytes).digest("hex");
  const quarantine = path.join(context.paths.quarantine, `corrupt-${digest}.data`);
  const auditPath = path.join(context.paths.quarantine, `doctor-audit-${digest}.json`);
  const outside = path.join(root, "outside.data");
  await writeFile(outside, bytes); await symlink(outside, quarantine);
  await writeFile(auditPath, `${JSON.stringify({ schema_version: 1,
    action: "quarantine_corrupt_json", source_path: source, quarantine_path: quarantine,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    recorded_at: context.now().toISOString() })}\n`);
  const report = await runDoctor(context, {});
  assert.equal(report.ok, false);
  assert.equal(report.issues.some(item => item.path === auditPath), true);
});

test("archive EEXIST after another repair removed source is idempotent", async t => {
  const { context } = await setup(t);
  const message = await sendMessage(context, messageRequest());
  await seedAcknowledgement(context, message);
  const racing = { ...context, linkArchiveRecord: async (source, destination) => {
    await link(source, destination); await unlink(source);
    const error = new Error("published concurrently"); error.code = "EEXIST"; throw error;
  } };
  const report = await runDoctor(racing, { repair: true });
  assert.equal(report.ok, true);
  assert.deepEqual(JSON.parse(await readFile(
    context.paths.archiveFile("models", message.id), "utf8")), message);
});

test("status distinguishes watcher mutex live young stale and corrupt", async t => {
  const { context } = await setup(t);
  for (const [agentId, age, pid, raw] of [
    ["live", 100_000, 4242], ["young", 60_000, 9999], ["stale", 60_001, 9999],
    ["corrupt", 0, 9999, "{}\n"],
  ]) {
    const directory = path.join(context.paths.locks, `watcher-${agentId}.lock`);
    await mkdir(directory);
    const owner = { schema_version: 1, kind: "watcher", agent_id: agentId, pid,
      token: `33333333-3333-4333-8333-${String(age).padStart(12, "0")}`,
      acquired_at: new Date(context.now().getTime() - age).toISOString() };
    await writeFile(path.join(directory, "owner.json"), raw ?? `${JSON.stringify(owner)}\n`);
  }
  const report = await collectStatus(context);
  assert.deepEqual(report.locks.watcher.live.map(item => item.owner.agent_id), ["live"]);
  assert.deepEqual(report.locks.watcher.young.map(item => item.owner.agent_id), ["young"]);
  assert.deepEqual(report.locks.watcher.stale.map(item => item.owner.agent_id), ["stale"]);
  assert.equal(report.locks.watcher.corrupt.length, 1);
  assert.equal((await runDoctor(context, {})).ok, false);
});

test("doctor repair recovers a stale doctor mutex with an audit", async t => {
  const { context } = await setup(t);
  const directory = path.join(context.paths.locks, "doctor.lock"); await mkdir(directory);
  const owner = { schema_version: 1, kind: "doctor", agent_id: null, pid: 9999,
    token: "55555555-5555-4555-8555-555555555555",
    acquired_at: new Date(context.now().getTime() - 60_001).toISOString() };
  await writeFile(path.join(directory, "owner.json"), `${JSON.stringify(owner)}\n`);
  const report = await runDoctor(context, { repair: true });
  assert.equal(report.ok, true);
  assert.equal(report.repairs.some(item => item.action === "repair_stale_doctor_mutex"), true);
  assert.equal(await pathExists(directory), false);
});

test("doctor repairs stale watcher mutex before stale watcher ownership", async t => {
  const { context } = await setup(t);
  const mutex = path.join(context.paths.locks, "watcher-models.lock"); await mkdir(mutex);
  const acquiredAt = new Date(context.now().getTime() - 60_001).toISOString();
  await writeFile(path.join(mutex, "owner.json"), `${JSON.stringify({ schema_version: 1,
    kind: "watcher", agent_id: "models", pid: 9999,
    token: "66666666-6666-4666-8666-666666666666", acquired_at: acquiredAt })}\n`);
  const ownership = path.join(context.paths.locks, "watcher-models.json");
  await writeFile(ownership, `${JSON.stringify({ schema_version: 1, agent_id: "models",
    pid: 9999, token: "77777777-7777-4777-8777-777777777777", acquired_at: acquiredAt })}\n`);
  const report = await runDoctor(context, { repair: true });
  assert.equal(report.ok, true);
  assert.deepEqual(report.repairs.map(item => item.action).filter(action =>
    action.includes("watcher")), ["repair_stale_watcher_mutex", "repair_stale_watcher_owner"]);
  assert.equal(await pathExists(mutex), false); assert.equal(await pathExists(ownership), false);
});
