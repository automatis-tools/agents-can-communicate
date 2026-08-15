import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import test from "node:test";

import { describeAttachment } from "../../../tools/agents/lib/attachments.mjs";
import { EXIT } from "../../../tools/agents/lib/errors.mjs";
import { createHandoff } from "../../../tools/agents/lib/handoff.mjs";
import { validateHandoff } from "../../../tools/agents/lib/schema.mjs";
import {
  createMessagingFixture,
  messageUuid,
  pathExists,
} from "./helpers.mjs";

const COMMIT = "b".repeat(40);
const BASE = "c".repeat(40);

async function validHandoff(context, overrides = {}) {
  await writeFile(`${context.repoRoot}/evidence.txt`, "evidence\n");
  const artifact = await describeAttachment(context, {
    path: "evidence.txt",
    ephemeral: false,
    commit: COMMIT,
  });
  return {
    from: "visual",
    to: "models",
    task: "M2.7",
    result: "Stable material slots added.",
    branch: "m2/visual",
    commit: COMMIT,
    base: BASE,
    changedPaths: ["game/presentation/tank.gd"],
    verification: [{ command: "node --test", exitCode: 0, summary: "pass" }],
    contracts: { added: [], changed: ["tank-registration-v1"], consumed: [] },
    followUp: ["models"],
    artifacts: [artifact],
    limitations: [],
    uncommitted: false,
    ...overrides,
  };
}

test("committed handoff requires branch, commit, base, paths, and verification", async t => {
  const { context } = await createMessagingFixture(t);
  const handoff = await validHandoff(context);

  await assert.rejects(
    createHandoff(context, { ...handoff, verification: [] }),
    error => error.exitCode === EXIT.DATA && error.message.includes("verification"),
  );
  for (const input of [
    { ...handoff, branch: "" },
    { ...handoff, commit: "b".repeat(39) },
    { ...handoff, base: "C".repeat(40) },
    { ...handoff, changedPaths: ["../tank.gd"] },
  ]) {
    await assert.rejects(createHandoff(context, input), error => error.exitCode === EXIT.DATA);
  }
});

test("uncommitted handoff is never ready to merge", async t => {
  const { context } = await createMessagingFixture(t);
  const handoff = await validHandoff(context, { commit: null, uncommitted: true });

  const { record, message } = await createHandoff(context, handoff);

  assert.equal(record.ready_to_merge, false);
  assert.equal(record.state, "UNCOMMITTED");
  assert.equal(message.type, "handoff");
  assert.equal(message.requires_ack, true);
  assert.match(message.body, /UNCOMMITTED/);
  assert.match(message.body, /never ready to merge/);
});

test("handoff record and addressed message share immutable evidence", async t => {
  const { context } = await createMessagingFixture(t, {
    randomUUID: () => messageUuid(1),
  });
  const handoff = await validHandoff(context);
  const { record, message } = await createHandoff(context, handoff);

  const stored = JSON.parse(await readFile(context.paths.handoffFile(record.id), "utf8"));
  assert.deepEqual(validateHandoff(stored), record);
  assert.deepEqual(message.attachments, record.artifacts);
  assert.match(message.body, new RegExp(record.id));
  assert.deepEqual(record.changed_paths, ["game/presentation/tank.gd"]);
  assert.deepEqual(record.follow_up, ["models"]);
  assert.equal(record.artifacts[0].sha256.length, 64);
  assert.equal(record.artifacts[0].size, 9);
  await assert.rejects(createHandoff(context, handoff), error => error.exitCode === EXIT.CONFLICT);
  assert.deepEqual(JSON.parse(await readFile(context.paths.handoffFile(record.id), "utf8")), record);
});

test("stale artifact evidence is rejected before handoff publication", async t => {
  const { context } = await createMessagingFixture(t);
  const handoff = await validHandoff(context);
  await writeFile(`${context.repoRoot}/evidence.txt`, "changed evidence\n");

  await assert.rejects(createHandoff(context, handoff), error => error.exitCode === EXIT.DATA);
  assert.deepEqual(await readdir(context.paths.handoffs), []);
});

test("failed verification is retained but cannot make a committed handoff ready", async t => {
  const { context } = await createMessagingFixture(t);
  const handoff = await validHandoff(context, {
    verification: [{ command: "node --test", exitCode: 1, summary: "failed" }],
  });

  const { record, message } = await createHandoff(context, handoff);

  assert.equal(record.ready_to_merge, false);
  assert.equal(record.state, "NOT_READY");
  assert.match(message.body, /exit 1/);
});

test("delivery failure preserves published handoff evidence for diagnosis", async t => {
  const { context } = await createMessagingFixture(t);
  const handoff = await validHandoff(context, { to: "missing" });

  await assert.rejects(createHandoff(context, handoff), error => error.exitCode === EXIT.CONFLICT);

  const files = await readdir(context.paths.handoffs);
  assert.equal(files.length, 1);
  const stored = validateHandoff(JSON.parse(await readFile(
    `${context.paths.handoffs}/${files[0]}`,
    "utf8",
  )));
  assert.equal(stored.to, "missing");
  assert.equal(await pathExists(context.paths.inboxDir("missing")), false);
});
