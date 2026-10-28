import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createPackedAcc } from "../helpers/packed-acc.mjs";
import { publishBacklogFixture } from "../helpers/backlog-fixture.mjs";
import { createMemoryStore } from "../helpers/memory-store.mjs";

// A real installed hook process with a version-only client shim. This checks
// projection and receipts, not whether a native model notices the reminder.
test("an installed hook preserves a prior backlog with client 2.1.233", async t => {
  const packed = await createPackedAcc(t);
  await packed.setClientVersions({ claude: "2.1.233", codex: "0.0.0" });
  const load = name => import(pathToFileURL(path.join(packed.installed,
    "node_modules", "@agents-can-communicate", name, "src", "index.mjs")));
  const [{ createCoordinationService }, { openFilesystemStore }, { createId },
    { discoverWorkspace, createGitProbe, runtimePaths }] = await Promise.all(
    ["core", "storage-filesystem", "protocol", "cli"].map(load));
  const descriptor = await discoverWorkspace({ cwd: packed.project, env: packed.env,
    gitProbe: createGitProbe({ env: packed.env }) });
  const clock = { now: () => "2026-08-01T12:00:00.000Z" };
  const ids = { next: kind => createId(kind, randomBytes) };
  const paths = runtimePaths({ dataHome: packed.dataHome, workspaceId: descriptor.id,
    workspaceRoots: descriptor.roots });
  const store = await openFilesystemStore({ root: paths.root, clock, ids,
    workspaceId: descriptor.id });
  const memory = createMemoryStore({ clock, ids, workspaceId: descriptor.id });
  const service = createCoordinationService({ store: memory, clock, ids });
  const open = participantId => service.openSession({ participantId, harness: "cli",
    heartbeatCadenceMs: 30_000, descriptor, workspaceId: descriptor.id });
  const owner = session => ({ sessionId: session.sessionId, generation: session.generation });
  const reader = await open("reader");
  const sender = await open("sender");
  const oldIds = [];
  for (let i = 0; i < 60; i += 1) {
    const message = await service.sendMessage({ ...owner(sender), clientMessageId: `old-${i}`,
      toParticipantIds: ["reader"], kind: i < 40 ? "request" : "decision",
      obligation: i < 40 ? "reply" : "acknowledge", subject: `Earlier review ${i}`,
      body: `Original review request ${i}; still unresolved.` });
    oldIds.push(message.messageId);
    if (i % 2 === 0) await service.readInbox({ ...owner(reader), messageId: message.messageId });
    else await service.recordOfferSucceeded({ messageId: message.messageId,
      recipientParticipantId: "reader", targetSessionId: reader.sessionId,
      targetGeneration: reader.generation, transport: "next-turn",
      adapterId: "claude_code", clientVersion: "2.1.233" });
  }
  await service.closeSession(owner(reader));
  await service.closeSession(owner(sender));
  await publishBacklogFixture({ memory, store, workspaceId: descriptor.id });
  // A SessionStart that fails open leaves the first turn to open another
  // participant, which has no message here; only the start's stderr says why
  // (the release suite on 2026-10-06 failed below without saying it).
  const started = await packed.hook("claude_code", { hook_event_name: "SessionStart",
    session_id: "native-reader", cwd: packed.project, source: "startup" },
  { ACC_PARTICIPANT: "reader" });
  assert.equal(started.stderr, "", "SessionStart must attach the reader");
  const freshSender = await packed.acc(["attach", "--participant", "sender"]);
  const body = "CURRENT_DECISION: use port 4317 for the new integration; review this change.";
  const fresh = await packed.acc(["request", "--session", freshSender.sessionId,
    "--generation", freshSender.generation, "--to", "reader", "--title", "Current review",
    "--detail", body]);
  const snapshot = async () => (await packed.acc(["sync", "--scope", "full"])).snapshot;
  const before = await snapshot();
  const oldReceipts = state => state.receipts.filter(item => oldIds.includes(item.messageId));
  assert.equal(oldReceipts(before).filter(item => item.state === "offered").length, 30);
  assert.equal(oldReceipts(before).filter(item => item.state === "retrieved").length, 30);
  const turn = async () => {
    const output = await packed.beforeTurn({ adapterId: "claude_code",
      harnessSessionId: "native-reader" });
    assert.equal(output.stderr, "");
    return JSON.parse(output.stdout).hookSpecificOutput.additionalContext;
  };
  const first = await turn();
  assert.equal(first.includes(body), true,
    `body delivery must follow the captured capability; the turn carried:\n${first}`);
  assert.match(first, /40 replies/);
  assert.match(first, /20 acknowledgements/);
  assert.ok(first.includes(`[reply_required] ${fresh.message.messageId}`),
    "a queued request is still an individual urgent item");
  assert.ok(Buffer.byteLength(first) < 1_000);
  assert.equal((await snapshot()).receipts.find(item => item.messageId === fresh.message.messageId).state,
    "offered", "a delivered body must advance its receipt");
  for (let i = 0; i < 3; i += 1) {
    const context = await turn();
    assert.ok(Buffer.byteLength(context) < 400, "repeated context grew with the backlog");
    assert.match(context, /41 replies/);
    assert.match(context, /20 acknowledgements/);
    assert.match(context, /`acc inbox`/);
    assert.ok(!context.includes(body), "an offered body was offered again");
    assert.ok(oldIds.every(id => !context.includes(id)));
  }
  const after = await snapshot();
  assert.deepEqual(oldReceipts(after), oldReceipts(before));
  assert.equal(after.receipts.find(item => item.messageId === fresh.message.messageId).state,
    "offered", "a reminder must not advance a receipt past its offer");
  const flags = /^ACC CLI \(append\): (--session \S+ --generation \S+) --cwd .+$/m.exec(first)[1]
    .split(" ");
  const status = await packed.acc(["status", ...flags]);
  assert.equal(status.attention.filter(item => ["reply_required", "acknowledgement_required"]
    .includes(item.kind)).length, 61);
  const messages = [];
  let cursor;
  do {
    const page = await packed.acc(["inbox", ...flags, ...(cursor ? ["--cursor", cursor] : [])]);
    messages.push(...page.items);
    cursor = page.nextCursor;
    assert.ok(messages.length <= 61, "inbox replayed a page");
  } while (cursor !== null);
  assert.equal(messages.length, 61);
  assert.equal(new Set(messages.map(item => item.message.messageId)).size, 61);
  const [current] = await packed.acc(["inbox", ...flags, "--message", fresh.message.messageId]);
  assert.equal(current.message.body, body, "explicit reading recovers the full body");
  assert.equal((await snapshot()).receipts.find(item => item.messageId === fresh.message.messageId).state,
    "retrieved", "only explicit reading retrieves the body");
  const [old] = await packed.acc(["inbox", ...flags, "--message", oldIds[0]]);
  assert.equal(old.message.body,
    "Original review request 0; still unresolved.");
});

// The future client must inherit captured delivery capabilities without needing
// another large backlog. Both offers below cross the actual installed hook.
test("an installed future-version hook preserves an old offer after reopening", async t => {
  const packed = await createPackedAcc(t);
  await packed.setClientVersions({ claude: "99.0.0", codex: "0.0.0" });
  const payload = { session_id: "native-future-reader", cwd: packed.project, source: "startup" };
  const start = async () => {
    const output = await packed.hook("claude_code", { ...payload, hook_event_name: "SessionStart" },
      { ACC_PARTICIPANT: "reader" });
    assert.equal(output.stderr, "", "SessionStart must attach the future-version reader");
  };
  const turn = async (body, label) => {
    const output = await packed.beforeTurn({ adapterId: "claude_code",
      harnessSessionId: payload.session_id });
    const context = JSON.parse(output.stdout).hookSpecificOutput.additionalContext;
    if (body) assert.ok(context.includes(body),
      `${label} body delivery must follow the captured capability; the turn carried:\n${context}`);
    assert.equal(output.stderr, "");
    return context;
  };
  const flags = context => /^ACC CLI \(append\): (--session \S+ --generation \S+) --cwd .+$/m
    .exec(context)[1].split(" ");
  const snapshot = async () => (await packed.acc(["sync", "--scope", "full"])).snapshot;
  const receipt = (state, id) => state.receipts.find(item => item.messageId === id
    && item.recipientParticipantId === "reader");
  await start();
  const sender = await packed.acc(["attach", "--participant", "sender"]);
  const request = (title, body) => packed.acc(["request", "--session", sender.sessionId,
    "--generation", sender.generation, "--to", "reader", "--title", title, "--detail", body]);
  const oldBody = "FUTURE_OLD_REQUEST: review the unresolved port 4301 integration.";
  const old = await request("Earlier future-client review", oldBody);
  const oldTurn = await turn(oldBody, "old");
  const prior = receipt(await snapshot(), old.message.messageId);
  assert.equal(prior.state, "offered");
  assert.deepEqual(prior.extensions.offer, { transport: "next-turn",
    at: prior.updatedAt, repeatedAt: null }, "old receipt must carry an actual next-turn offer");
  assert.ok(Number.isFinite(Date.parse(prior.updatedAt)), "old offer must have a durable timestamp");
  const ended = await packed.hook("claude_code", { ...payload,
    hook_event_name: "SessionEnd", reason: "other" });
  assert.equal(ended.stderr, "", "SessionEnd must close the old native owner");
  await start();
  assert.deepEqual(receipt(await snapshot(), old.message.messageId), prior,
    "native close/reopen must preserve the old receipt");
  const body = "FUTURE_CURRENT_REQUEST: use port 4317 for the new integration.";
  const fresh = await request("Current future-client review", body);
  const first = await turn(body, "fresh");
  assert.ok(!first.includes(oldBody), "an old offered body must not replay after reopening");
  assert.match(first, /1 reply/);
  assert.ok(first.includes(`[reply_required] ${fresh.message.messageId}`),
    "the new queued request must remain an individual urgent item");
  assert.ok(Buffer.byteLength(first) < 1_000);
  const currentFlags = flags(first);
  assert.notDeepEqual(currentFlags, flags(oldTurn), "reopening must replace the native owner");
  const offered = await snapshot();
  assert.equal(receipt(offered, fresh.message.messageId).state, "offered",
    "a delivered future-version body must advance its receipt");
  assert.deepEqual(receipt(offered, old.message.messageId), prior,
    "fresh delivery must not advance the old receipt");
  const repeated = await turn();
  assert.ok(Buffer.byteLength(repeated) < 400, "repeated future-version context must stay compact");
  assert.match(repeated, /2 replies/);
  assert.match(repeated, /`acc inbox`/);
  assert.ok(!repeated.includes(body), "the fresh offered body must not replay");
  assert.ok(!repeated.includes(oldBody), "the old offered body must not replay");
  assert.ok(!repeated.includes(old.message.messageId));
  assert.ok(!repeated.includes(fresh.message.messageId));
  const after = await snapshot();
  assert.equal(receipt(after, fresh.message.messageId).state, "offered",
    "a reminder must not retrieve the fresh body");
  assert.deepEqual(receipt(after, old.message.messageId), prior,
    "compact reminders must preserve the old receipt");
  const [current] = await packed.acc(["inbox", ...currentFlags,
    "--message", fresh.message.messageId]);
  assert.equal(current.message.body, body, "explicit reading must recover the full fresh body");
  const retrieved = await snapshot();
  assert.equal(receipt(retrieved, fresh.message.messageId).state, "retrieved",
    "only explicit reading retrieves the fresh body");
  assert.deepEqual(receipt(retrieved, old.message.messageId), prior,
    "explicit fresh reading must leave the old obligation receipt unchanged");
});
