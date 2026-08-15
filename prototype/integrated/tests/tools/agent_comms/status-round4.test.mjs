import assert from "node:assert/strict";
import { mkdir, open, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { writeJsonAtomic } from "../../../tools/agents/lib/atomic-json.mjs";
import { archiveAcknowledged } from "../../../tools/agents/lib/doctor-storage.mjs";
import { EXIT } from "../../../tools/agents/lib/errors.mjs";
import { sendMessage } from "../../../tools/agents/lib/messages.mjs";
import { validateProtocol } from "../../../tools/agents/lib/schema.mjs";
import { collectStatus, enforcementExit, runDoctor }
  from "../../../tools/agents/lib/status.mjs";
import { createBusFixture, messageRequest, pathExists, seedAcknowledgement,
  seedOpenAgent } from "./helpers.mjs";

async function setup(t) {
  const fixture = await createBusFixture(); t.after(fixture.cleanup);
  let uuid = 1;
  const context = { ...fixture.context, pid: 4242, pidIsAlive: pid => pid === 4242,
    randomUUID: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(uuid++).padStart(12, "0")}`,
    randomMutexUUID: () => `bbbbbbbb-bbbb-4bbb-8bbb-${String(uuid++).padStart(12, "0")}` };
  await Promise.all(["visual", "models"].map(agentId => seedOpenAgent(context,
    { agentId, task: "M2.7" })));
  const protocol = validateProtocol({ schema_version: 1, protocol_version: 1,
    checkout_id: "c".repeat(64), checkout_root: fixture.root,
    initialized_at: context.now().toISOString() });
  await writeJsonAtomic(context.paths.protocol, protocol,
    { tmpDir: context.paths.tmp, exclusive: true });
  return { ...fixture, context };
}

async function ackedMessage(context) {
  const message = await sendMessage(context, messageRequest());
  await seedAcknowledgement(context, message);
  return message;
}

function enoent() {
  const error = new Error("source disappeared"); error.code = "ENOENT";
  return error;
}

for (const [name, basename, createArtifact] of [
  ["audit without extension", "mutex-audit-malformed",
    filePath => writeFile(filePath, "{malformed")],
  ["stale target", "mutex-stale-malformed.extra", filePath => mkdir(filePath)],
]) test(`malformed mutex ${name} is corrupt and blocks repair`, async t => {
  const { context } = await setup(t);
  const artifact = path.join(context.paths.quarantine, basename);
  await createArtifact(artifact);
  const message = await ackedMessage(context);

  const doctor = await runDoctor(context, { repair: true });

  assert.equal(doctor.issues.some(item => item.path === artifact), true);
  assert.equal(await pathExists(context.paths.inboxFile(message.to, message.id)), true);
});

test("direct archive ENOENT rejects a destination swapped to a symlink at open", async t => {
  const { context, root } = await setup(t);
  const message = await ackedMessage(context);
  const destination = context.paths.archiveFile(message.to, message.id);
  const outside = path.join(root, "outside-archive.json");
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(message)}\n`);
  await writeFile(outside, `${JSON.stringify(message)}\n`);
  let swapped = false;
  const racing = { ...context, linkArchiveRecord: async () => { throw enoent(); },
    openArchiveRecord: async (filePath, flags) => {
      if (!swapped) {
        swapped = true; await unlink(filePath); await symlink(outside, filePath);
      }
      return open(filePath, flags);
    } };

  await assert.rejects(archiveAcknowledged(racing, message),
    error => error.exitCode === EXIT.DATA);
  assert.equal(await pathExists(context.paths.inboxFile(message.to, message.id)), true);
});

for (const [kind, basename] of [
  ["doctor", "doctor.lock"], ["watcher", "watcher-models.lock"],
]) test(`enforcement treats a corrupt ${kind} mutex as data corruption`, async t => {
  const { context } = await setup(t);
  const mutex = path.join(context.paths.locks, basename);
  await mkdir(mutex);
  await writeFile(path.join(mutex, "owner.json"), "{}\n");

  const status = await collectStatus(context);

  assert.equal(kind === "doctor" ? status.locks.doctor.state
    : status.locks.watcher.corrupt[0].state, "corrupt");
  assert.equal(enforcementExit(status, {}), EXIT.DATA);
});
