import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { storeNativeAttempt, storeSessionBinding } from "@agents-can-communicate/adapter-sdk";

import { lastNativeReason } from "../src/native-reason.mjs";

const attempt = (state, reasonCode) => ({ at: "2026-09-29T04:00:00.000Z", event: "beforeTurn",
  state, reasonCode, policy: "actionable", policySource: "installation-record",
  policyStatus: "enabled", clientProcess: "identified" });

async function runtime(t) {
  const runtimeDir = await realpath(await mkdtemp(path.join(tmpdir(), "acc-reason-")));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const owner = { runtimeDir, harnessSessionId: "thread-1", accSessionId: "session_one",
    generation: "generation_one" };
  await storeSessionBinding(owner);
  return owner;
}

test("the reason is the recipient session's last native attempt", async t => {
  const owner = await runtime(t);
  assert.equal(await storeNativeAttempt({ ...owner,
    nativeAttempt: attempt("degraded", "client_session_embedded") }), true);
  assert.equal(await lastNativeReason({ runtimeDir: owner.runtimeDir,
    sessionId: "session_one", generation: "generation_one" }), "client_session_embedded");
});

test("no reason for another generation, an active attempt, no attempt or no runtime", async t => {
  const owner = await runtime(t);
  const read = input => lastNativeReason({ runtimeDir: owner.runtimeDir, sessionId: "session_one",
    generation: "generation_one", ...input });
  assert.equal(await read({}), null, "no attempt recorded");
  await storeNativeAttempt({ ...owner, nativeAttempt: attempt("active", null) });
  assert.equal(await read({}), null);
  await storeNativeAttempt({ ...owner, nativeAttempt: attempt("degraded", "handshake_failed") });
  assert.equal(await read({ generation: "generation_two" }), null);
  assert.equal(await read({ sessionId: "session_two" }), null);
  assert.equal(await lastNativeReason({ runtimeDir: undefined, sessionId: "session_one",
    generation: "generation_one" }), null);
});
