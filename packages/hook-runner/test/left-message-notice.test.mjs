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

// #320: a message left for a session that ended reaches each later session's
// context once. The notice is remembered only after its bytes are written,
// the same post-write commit that records an offer.
const platform = `${process.platform}-${process.arch}`;
const left = {
  id: "left",
  client: { command: "left", certificationName: "left", versionArgs: ["--version"] },
  capabilities: { delivery: { nextTurn: true } },
  certification: { evidence: [{ client: "left", version: "1.0.0", platform,
    capability: "delivery.nextTurn", result: "pass" }] },
  normalizeHook: payload => payload,
  injectOutcome: text => ({ stdout: text, stderr: "", exitCode: 0 }),
  renderContext: (sync, options) => projectContextResult(sync, options).text,
  renderContextResult: (sync, options) => projectContextResult(sync, options),
};

const event = (kind, root, sessionId, extra = {}) => ({ kind, sessionId, cwd: root,
  model: null, parentSessionId: null, tool: null, targets: [], ...extra });

async function leftBehind(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-left-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-left-data-")));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));
  const runtime = { clock: { now: () => new Date().toISOString() },
    ids: { next: kind => createId(kind, randomBytes) }, realpath };
  const invoke = payload => runHook({ includeSessions: true, adapterId: "left", payload,
    adapters: { left }, dataHome, readProcessTable: async () => new Map(),
    probeClientVersion: async () => "1.0.0", platform, runtime });
  const recipient = await invoke(event("sessionStart", root, "harness-recipient"));
  const peer = await invoke(event("sessionStart", root, "harness-peer"));
  const recipientParticipant = recipient.sessions
    .find(session => session.sessionId === recipient.accSessionId).participantId;
  const { root: storeRoot, workspaceId } = recipient.service.store;
  const sender = createCoordinationService({ clock: runtime.clock, ids: runtime.ids,
    store: await openFilesystemStore({ root: storeRoot, workspaceId, clock: runtime.clock,
      ids: runtime.ids }) });
  const message = await sender.sendMessage({ sessionId: peer.accSessionId,
    generation: peer.generation, clientMessageId: "client_left",
    toParticipantIds: [recipientParticipant], kind: "note", obligation: "none",
    subject: "Review findings", body: "two edge cases are untested" });
  await sender.closeSession({ sessionId: recipient.accSessionId, workspaceId,
    generation: recipient.generation });
  return { root, invoke, message, sender, workspaceId };
}

test("a later session's context carries a left message once, after the bytes are written", async t => {
  const { root, invoke, message } = await leftBehind(t);
  await invoke(event("sessionStart", root, "harness-later"));

  const first = await invoke(event("beforeTurn", root, "harness-later"));
  assert.match(first.stdout, new RegExp(`\\[left_for_ended_session\\] ${message.messageId}`));
  assert.match(first.stdout, new RegExp(`sync --scope history --message ${message.messageId}`));

  const unwritten = await invoke(event("beforeTurn", root, "harness-later"));
  assert.match(unwritten.stdout, new RegExp(message.messageId),
    "a notice whose bytes were never confirmed must be shown again");

  await unwritten.commitOffers();
  const after = await invoke(event("beforeTurn", root, "harness-later"));
  assert.doesNotMatch(after.stdout ?? "", new RegExp(message.messageId));
});

test("another later session is still told after the first one was", async t => {
  const { root, invoke, message } = await leftBehind(t);
  await invoke(event("sessionStart", root, "harness-later"));
  const told = await invoke(event("beforeTurn", root, "harness-later"));
  await told.commitOffers();

  await invoke(event("sessionStart", root, "harness-other"));
  const other = await invoke(event("beforeTurn", root, "harness-other"));

  assert.match(other.stdout, new RegExp(`\\[left_for_ended_session\\] ${message.messageId}`));
});

test("a notice that cannot be recorded leaves the offer commit standing", async t => {
  const { root, invoke, message, sender, workspaceId } = await leftBehind(t);
  const later = await invoke(event("sessionStart", root, "harness-later"));
  const turn = await invoke(event("beforeTurn", root, "harness-later"));
  assert.match(turn.stdout, new RegExp(message.messageId));

  // The session closes between the write and the commit: the notice cannot be
  // recorded, and it is shown again next time, which is the safe direction.
  await sender.closeSession({ sessionId: later.accSessionId, workspaceId,
    generation: later.generation });

  await turn.commitOffers();
});
