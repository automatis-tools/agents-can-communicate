import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, rename, symlink, unlink, writeFile }
  from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { writeJsonAtomic } from "../../../tools/agents/lib/atomic-json.mjs";
import { archiveAcknowledged } from "../../../tools/agents/lib/doctor-storage.mjs";
import { EXIT } from "../../../tools/agents/lib/errors.mjs";
import { sendMessage } from "../../../tools/agents/lib/messages.mjs";
import { inspectRepairMutex, repairStaleRepairMutex }
  from "../../../tools/agents/lib/repair-mutex.mjs";
import { validateProtocol } from "../../../tools/agents/lib/schema.mjs";
import { collectStatus, runDoctor } from "../../../tools/agents/lib/status.mjs";
import { createBusFixture, messageRequest, pathExists, seedAcknowledgement,
  seedOpenAgent } from "./helpers.mjs";

async function setup(t) {
  const fixture = await createBusFixture(); t.after(fixture.cleanup);
  let uuid = 1;
  const context = { ...fixture.context, pid: 4242, pidIsAlive: pid => pid === 4242,
    randomUUID: () => `88888888-8888-4888-8888-${String(uuid++).padStart(12, "0")}`,
    randomMutexUUID: () => `99999999-9999-4999-8999-${String(uuid++).padStart(12, "0")}` };
  await Promise.all(["visual", "models"].map(agentId => seedOpenAgent(context,
    { agentId, task: "M2.7" })));
  const protocol = validateProtocol({ schema_version: 1, protocol_version: 1,
    checkout_id: "c".repeat(64), checkout_root: fixture.root,
    initialized_at: context.now().toISOString() });
  await writeJsonAtomic(context.paths.protocol, protocol,
    { tmpDir: context.paths.tmp, exclusive: true });
  return { ...fixture, context };
}
function enoent() { const error = new Error("source disappeared"); error.code = "ENOENT";
  return error; }
async function ackedMessage(context) {
  const message = await sendMessage(context, messageRequest());
  await seedAcknowledgement(context, message); return message;
}

test("direct archive link ENOENT accepts only an equal strict destination", async t => {
  const { context } = await setup(t); const message = await ackedMessage(context);
  const destination = context.paths.archiveFile(message.to, message.id);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(message)}\n`);
  const racing = { ...context, linkArchiveRecord: async () => { throw enoent(); } };
  assert.equal(await archiveAcknowledged(racing, message), null);
  assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), message);
});

test("direct archive link ENOENT rejects a conflicting destination", async t => {
  const { context } = await setup(t); const message = await ackedMessage(context);
  const destination = context.paths.archiveFile(message.to, message.id);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify({ ...message, body: "conflicting B" })}\n`);
  const racing = { ...context, linkArchiveRecord: async () => { throw enoent(); } };
  await assert.rejects(archiveAcknowledged(racing, message),
    error => error.exitCode === EXIT.DATA);
  assert.equal(await pathExists(context.paths.inboxFile(message.to, message.id)), true);
});

test("blocking watcher mutex files and symlinks are corrupt and preserved", async t => {
  const { context, root } = await setup(t);
  const regular = path.join(context.paths.locks, "watcher-models.lock");
  const target = path.join(root, "outside.lock");
  const symbolic = path.join(context.paths.locks, "watcher-visual.lock");
  await writeFile(regular, "blocking file"); await writeFile(target, "outside");
  await symlink(target, symbolic);
  const status = await collectStatus(context);
  assert.deepEqual(status.locks.watcher.corrupt.map(item => item.path), [regular, symbolic]);
  const doctor = await runDoctor(context, { repair: true });
  assert.equal(doctor.ok, false); assert.equal(await pathExists(regular), true);
  assert.equal((await lstat(symbolic)).isSymbolicLink(), true);
});

async function repairedMutex(context) {
  const directory = path.join(context.paths.locks, "watcher-models.lock");
  await mkdir(directory);
  const target = { schema_version: 1, kind: "watcher", agent_id: "models", pid: 9999,
    token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    acquired_at: new Date(context.now().getTime() - 60_001).toISOString() };
  await writeFile(path.join(directory, "owner.json"), `${JSON.stringify(target)}\n`);
  assert.equal(await repairStaleRepairMutex(context, "watcher", "models"), true);
  const names = await readdir(context.paths.quarantine);
  return { auditPath: path.join(context.paths.quarantine,
    names.find(name => name.startsWith("mutex-audit-"))), targetPath: path.join(
    context.paths.quarantine, names.find(name => name.startsWith("mutex-stale-"))) };
}

for (const [name, damage] of [
  ["missing audit", async ({ auditPath }, context) => rename(auditPath,
    path.join(context.root, "missing-mutex-audit.json"))],
  ["missing target", async ({ targetPath }, context) => rename(targetPath,
    path.join(context.root, "missing-mutex-target"))],
  ["filename digest", async ({ auditPath }) => rename(auditPath,
    path.join(path.dirname(auditPath), `mutex-audit-${"0".repeat(64)}.json`))],
  ["canonical target", async ({ auditPath }, context) => {
    const audit = JSON.parse(await readFile(auditPath)); audit.quarantine_path = context.paths.tmp;
    await writeFile(auditPath, `${JSON.stringify(audit)}\n`);
  }],
  ["audit target owner", async ({ auditPath }) => {
    const audit = JSON.parse(await readFile(auditPath)); audit.target.pid = 9998;
    await writeFile(auditPath, `${JSON.stringify(audit)}\n`);
  }],
  ["moved owner bytes", async ({ targetPath }) => {
    const ownerPath = path.join(targetPath, "owner.json");
    const owner = JSON.parse(await readFile(ownerPath)); owner.pid = 9998;
    await writeFile(ownerPath, `${JSON.stringify(owner)}\n`);
  }],
]) test(`mutex audit rejects damaged ${name} and blocks archive repair`, async t => {
  const { context, root } = await setup(t); const paths = await repairedMutex(context);
  await damage(paths, { ...context, root }); const message = await ackedMessage(context);
  const doctor = await runDoctor(context, { repair: true });
  assert.equal(doctor.ok, false);
  assert.equal(await pathExists(context.paths.inboxFile(message.to, message.id)), true);
});

test("doctor audit quarantine read rejects a swap at the no-follow open", async t => {
  const { context, root } = await setup(t);
  const source = context.paths.inboxFile("models", "broken");
  await mkdir(path.dirname(source), { recursive: true }); await writeFile(source, "{broken");
  const repaired = await runDoctor(context, { repair: true });
  const quarantine = repaired.repairs[0].quarantine_path;
  const outside = path.join(root, "outside.data");
  await writeFile(outside, await readFile(quarantine)); let swapped = false;
  const racing = { ...context, openImmutableRecord: async (filePath, flags) => {
    if (!swapped && filePath === quarantine) {
      swapped = true; await unlink(quarantine); await symlink(outside, quarantine);
    }
    return open(filePath, flags);
  } };
  assert.equal((await runDoctor(racing, {})).ok, false);
});

test("repair mutex owner read rejects a swap at the no-follow open", async t => {
  const { context, root } = await setup(t);
  const directory = path.join(context.paths.locks, "watcher-models.lock"); await mkdir(directory);
  const ownerPath = path.join(directory, "owner.json");
  const owner = { schema_version: 1, kind: "watcher", agent_id: "models", pid: 4242,
    token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    acquired_at: context.now().toISOString() };
  await writeFile(ownerPath, `${JSON.stringify(owner)}\n`);
  const outside = path.join(root, "outside-owner.json");
  await writeFile(outside, `${JSON.stringify(owner)}\n`); let swapped = false;
  const racing = { ...context, openMutexOwner: async (filePath, flags) => {
    if (!swapped) { swapped = true; await unlink(filePath); await symlink(outside, filePath); }
    return open(filePath, flags);
  } };
  assert.equal((await inspectRepairMutex(racing, "watcher", "models")).state, "corrupt");
});
