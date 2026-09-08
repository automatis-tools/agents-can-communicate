import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { storeSessionBinding } from "@agents-can-communicate/adapter-sdk";
import { resolveOwner } from "../src/session-owner.mjs";

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), "acc-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const participants = [
    { sessionId: "session_peer", participantId: "peer", harness: "claude_code",
      checkoutRoot: "/same-checkout", presence: "online" },
    { sessionId: "session_other", participantId: "other", harness: "codex",
      checkoutRoot: "/another-checkout", presence: "online" },
  ];
  for (const participant of participants) {
    await storeSessionBinding({ runtimeDir: root, harnessSessionId: `native-${participant.participantId}`,
      accSessionId: participant.sessionId, generation: `generation_${participant.participantId}` });
  }
  return { paths: { root }, descriptor: { git: { worktreeRoot: "/same-checkout" } },
    service: { collectStatus: async () => ({ participants }) } };
}

const unresolved = error => error.code === 2
  && error.details.reasonCode === "caller_identity_unresolved";

test("a matching checkout cannot identify a caller among other sessions", async t => {
  const context = await setup(t);
  await assert.rejects(resolveOwner({ command: "work", options: {}, context,
    env: { NATIVE_SESSION: "unbound" } }), unresolved);
});

test("ambiguous native identity cannot fall back to checkout", async t => {
  const context = await setup(t);
  await assert.rejects(resolveOwner({ command: "work", options: {}, context,
    env: { CURRENT: "native-peer", INHERITED: "native-other" } }), unresolved);
});

test("an inherited peer native id cannot identify an unbound caller", async t => {
  const context = await setup(t);
  await assert.rejects(resolveOwner({ command: "work", options: {}, context,
    env: { CURRENT_CLIENT_SESSION: "unbound", INHERITED_PARENT_SESSION: "native-peer" } }), unresolved);
});

test("even a single native environment match is not ownership proof", async t => {
  const context = await setup(t);
  await assert.rejects(resolveOwner({ command: "inbox", options: {}, context,
    env: { NATIVE_SESSION: "native-other" } }), unresolved);
});

test("explicit ownership works across checkouts without discarding a supplied generation", async t => {
  const context = await setup(t);
  const result = await resolveOwner({ command: "work", options: { generation: "stale" }, context,
    env: { ACC_SESSION: "session_other", ACC_GENERATION: "generation_other" } });
  assert.equal(result.session, "session_other");
  assert.equal(result.generation, "stale", "the core must reject this stale token, not replace it");
});

test("an explicit environment pair cannot be redirected with a public session selector", async t => {
  const context = await setup(t);
  await assert.rejects(resolveOwner({ command: "work", options: { session: "session_peer" }, context,
    env: { ACC_SESSION: "session_other", ACC_GENERATION: "generation_other" } }), unresolved);
});

test("a manually attached owner can select itself using its explicit environment pair", async t => {
  const context = await setup(t);
  const result = await resolveOwner({ command: "work", options: { session: "session_manual" }, context,
    env: { ACC_SESSION: "session_manual", ACC_GENERATION: "generation_manual" } });
  assert.equal(result.session, "session_manual");
  assert.equal(result.generation, "generation_manual");
});
