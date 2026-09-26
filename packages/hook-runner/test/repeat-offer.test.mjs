import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { projectContextResult } from "@agents-can-communicate/adapter-sdk";
import { createCoordinationService } from "@agents-can-communicate/core";
import { createId } from "@agents-can-communicate/protocol";
import { openFilesystemStore } from "@agents-can-communicate/storage-filesystem";

import { runHook } from "../src/runner.mjs";

// A live transport accepted a peer message and nothing followed: no retrieval,
// no acknowledgement. Fifteen minutes later the recipient's next turn shows the
// body once more, through the certified hook path, and says it is a repeat.
const REPEAT_AFTER_MS = 15 * 60 * 1000;
const platform = `${process.platform}-${process.arch}`;

const adapter = ({ nextTurn = true } = {}) => ({
  id: "rep",
  client: { command: "rep", certificationName: "rep", versionArgs: ["--version"] },
  capabilities: { delivery: { nextTurn } },
  certification: { evidence: nextTurn ? [{ client: "rep", version: "1.0.0", platform,
    capability: "delivery.nextTurn", result: "pass" }] : [] },
  normalizeHook: payload => payload,
  injectOutcome: text => ({ stdout: text, stderr: "", exitCode: 0 }),
  renderContext: (sync, options) => projectContextResult(sync, options).text,
  renderContextResult: (sync, options) => projectContextResult(sync, options),
  continueTurnOutcome: ({ reason }) =>
    ({ stdout: `${JSON.stringify({ decision: "continue", reason })}\n`, stderr: "", exitCode: 0 }),
});

async function workspace(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-repeat-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-repeat-data-")));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));
  return { root, dataHome };
}

const event = (kind, root, extra = {}) => ({ kind, sessionId: "harness-session-1", cwd: root,
  model: null, parentSessionId: null, tool: null, targets: [], ...extra });

async function withLiveOffer(t, options = {}) {
  const place = await workspace(t);
  let offset = 0;
  const runtime = { clock: { now: () => new Date(Date.now() + offset).toISOString() },
    ids: { next: kind => createId(kind, randomBytes) }, realpath };
  const rep = adapter(options);
  const invoke = payload => runHook({ adapterId: "rep", payload, adapters: { rep },
    dataHome: place.dataHome, readProcessTable: async () => new Map(),
    probeClientVersion: async () => "1.0.0", platform, runtime });
  const recipient = await invoke(event("sessionStart", place.root));
  const peer = await invoke(event("sessionStart", place.root, { sessionId: "peer-session" }));
  const participantId = recipient.sessions
    .find(session => session.sessionId === recipient.accSessionId).participantId;
  // The send and the router's record run in the sender's own process. A hook's
  // service carries that hook's budget, which has run out by now under load.
  const { root, workspaceId } = recipient.service.store;
  const sender = createCoordinationService({ clock: runtime.clock, ids: runtime.ids,
    store: await openFilesystemStore({ root, workspaceId, clock: runtime.clock, ids: runtime.ids }) });
  const message = await sender.sendMessage({ sessionId: peer.accSessionId,
    generation: peer.generation, clientMessageId: "client_repeat",
    toParticipantIds: [participantId], kind: options.kind ?? "note",
    obligation: options.obligation ?? "none",
    subject: "Schema verified", body: "checked at abc123, nothing to do" });
  // What the router records when a live transport accepts the bytes.
  await sender.recordOfferSucceeded({ messageId: message.messageId,
    recipientParticipantId: participantId, targetSessionId: recipient.accSessionId,
    targetGeneration: recipient.generation, transport: "codex-app-server",
    adapterId: "rep", clientVersion: "1.0.0" });
  const receipt = () => sender.readReceipt({ messageId: message.messageId,
    recipientParticipantId: participantId });
  return { place, invoke, message, receipt, advance: ms => { offset += ms; } };
}

test("the next turn shows a live offer nobody followed up, once, and says so", async t => {
  const { place, invoke, message, receipt, advance } = await withLiveOffer(t);
  advance(REPEAT_AFTER_MS + 1_000);

  const turn = await invoke(event("beforeTurn", place.root));

  assert.match(turn.stdout, new RegExp(`messageId: ${message.messageId}`));
  assert.match(turn.stdout, /checked at abc123, nothing to do/);
  assert.match(turn.stdout, /repeat: offered via codex-app-server at \S+; no retrieval recorded/);
  // Recorded only once the bytes are written, exactly as a first offer is.
  assert.equal((await receipt()).extensions.offer.repeatedAt, null);
  await turn.commitOffers();
  const repeated = await receipt();
  assert.equal(repeated.state, "offered");
  assert.equal(typeof repeated.extensions.offer.repeatedAt, "string");

  const next = await invoke(event("beforeTurn", place.root));
  assert.doesNotMatch(next.stdout, /checked at abc123/);
});

test("a repeat is never a reason to hold a turn open", async t => {
  const { place, invoke, receipt, advance } = await withLiveOffer(t);
  advance(REPEAT_AFTER_MS + 1_000);

  const ended = await invoke(event("turnEnd", place.root, { executionNum: 0 }));
  await ended.commitOffers?.();

  assert.equal(ended.stdout ?? "", "");
  assert.equal((await receipt()).extensions.offer.repeatedAt, null);
});

test("before the threshold the next turn leaves a live offer alone", async t => {
  const { place, invoke, receipt, advance } = await withLiveOffer(t);
  advance(REPEAT_AFTER_MS - 60_000);

  const turn = await invoke(event("beforeTurn", place.root));
  await turn.commitOffers();

  assert.doesNotMatch(turn.stdout, /checked at abc123/);
  assert.equal((await receipt()).extensions.offer.repeatedAt, null);
});

test("a client that cannot take a next-turn body keeps its reminder instead", async t => {
  const { place, invoke, receipt, advance } = await withLiveOffer(t,
    { nextTurn: false, kind: "question", obligation: "reply" });
  advance(REPEAT_AFTER_MS + 1_000);

  const turn = await invoke(event("beforeTurn", place.root));
  await turn.commitOffers();

  // Selecting a repeat takes it out of the reminder count. A turn that cannot
  // show the body must not ask for one, or the question would go quiet.
  assert.match(turn.stdout, /Pending: 1 reply/);
  assert.doesNotMatch(turn.stdout, /repeat:/);
  assert.equal((await receipt()).extensions.offer.repeatedAt, null);
});
