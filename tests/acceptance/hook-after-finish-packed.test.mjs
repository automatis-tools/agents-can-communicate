import assert from "node:assert/strict";
import test from "node:test";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

// Installed processes reproduce a native conversation that continues after
// finish, without receiving another SessionStart. Real-client evidence is separate.
function ownerFlags(stdout, adapterId) {
  const context = adapterId === "codex" ? stdout : stdout.trim() === "" ? ""
    : JSON.parse(stdout).hookSpecificOutput?.additionalContext ?? "";
  const match = /^ACC CLI \(append\): --session (\S+) --generation (\S+)$/m.exec(context);
  assert.ok(match, "the next user turn must supply usable owner arguments");
  return ["--session", match[1], "--generation", match[2]];
}

for (const adapterId of ["claude_code", "codex"]) {
  test(`${adapterId} continues after partial finish with a fresh owner in the same conversation`, async t => {
    const packed = await createPackedAcc(t);
    const payload = { session_id: "native-conversation", cwd: packed.project };
    const hook = name => packed.hook(adapterId, { ...payload, hook_event_name: name,
      prompt: "Continue with my approval" });
    const snapshot = async () => (await packed.acc(["sync", "--scope", "full"])).snapshot;
    await hook("SessionStart");
    const first = ownerFlags((await hook("UserPromptSubmit")).stdout, adapterId);
    await packed.acc(["work", ...first, "--summary", "waiting for permission"]);
    await packed.acc(["claim", ...first, "--resource", "file:stock.mjs"]);
    const done = await packed.acc(["finish", ...first, "--status", "partial",
      "--goal", "Waiting for approval to continue"]);
    const before = await snapshot();
    const closed = before.sessions.find(s => s.sessionId === first[1]);
    assert.equal(closed.state, "closed");

    // A tool hook must not manufacture a new owner after completion.
    await packed.hook(adapterId, { ...payload, hook_event_name: "PreToolUse",
      tool_name: "Bash", tool_input: { command: "true" } });
    assert.deepEqual((await snapshot()).sessions, before.sessions);
    const staleHeartbeat = await packed.accError(["heartbeat", ...first]);
    assert.equal(staleHeartbeat?.code, 5);

    const fresh = ownerFlags((await hook("UserPromptSubmit")).stdout, adapterId);
    assert.notEqual(fresh[1], first[1]);
    assert.notEqual(fresh[3], first[3]);
    const claim = await packed.acc(["claim", ...fresh, "--resource", "file:stock.mjs"]);
    assert.equal(claim.ownerSessionId, fresh[1]);
    const stale = await packed.accError(["claim", ...first, "--resource", "file:other.mjs"]);
    assert.equal(stale?.code, 5);
    const after = await snapshot();
    assert.deepEqual(after.sessions.find(s => s.sessionId === first[1]), closed);
    assert.deepEqual(after.messages.find(m => m.messageId === done.message.messageId),
      before.messages.find(m => m.messageId === done.message.messageId));
    assert.equal(after.sessions.length, 2);
    assert.equal(after.sessions.find(s => s.sessionId === fresh[1]).participantId,
      closed.participantId, "the native conversation keeps its participant address");
    assert.deepEqual(ownerFlags((await hook("UserPromptSubmit")).stdout, adapterId), fresh);
    await packed.acc(["finish", ...fresh, "--goal", "approved work complete"]);
    const beforeEnd = await snapshot();
    const closedFresh = beforeEnd.sessions.find(s => s.sessionId === fresh[1]);
    assert.equal(closedFresh.state, "closed");
    await hook("SessionEnd");
    assert.equal(await packed.findBinding(payload.session_id), null);
    const next = ownerFlags((await hook("UserPromptSubmit")).stdout, adapterId);
    const binding = await packed.findBinding(payload.session_id);
    assert.notDeepEqual(next, fresh);
    assert.equal(binding.accSessionId, next[1]);
    assert.equal(binding.generation, next[3]);
    const afterEnd = await snapshot();
    assert.deepEqual(afterEnd.sessions.find(s => s.sessionId === first[1]), closed);
    assert.deepEqual(afterEnd.sessions.find(s => s.sessionId === fresh[1]), closedFresh);
    assert.equal(afterEnd.sessions.find(s => s.sessionId === next[1]).state, "open");
    assert.equal(afterEnd.sessions.length, 3);
  });
}

for (const adapterId of ["claude_code", "codex"]) {
  test(`${adapterId} resumes a detached solo conversation whose ephemeral owner is absent`, async t => {
    const packed = await createPackedAcc(t);
    const payload = { session_id: "solo-conversation", cwd: packed.project };
    const hook = name => packed.hook(adapterId, { ...payload, hook_event_name: name,
      prompt: "Continue after detach" });
    await hook("SessionStart");
    const first = ownerFlags((await hook("UserPromptSubmit")).stdout, adapterId);
    const before = await packed.acc(["status"]);
    assert.equal(before.materialised, false);
    assert.equal(before.counts.live, 1);
    const participantId = before.participants[0].participantId;

    await packed.acc(["detach", ...first]);
    const detached = await packed.acc(["status"]);
    assert.equal(detached.materialised, false);
    assert.deepEqual(detached.participants, []);
    const oldBinding = await packed.findBinding(payload.session_id);
    assert.equal(oldBinding.accSessionId, first[1]);
    await packed.hook(adapterId, { ...payload, hook_event_name: "PreToolUse",
      tool_name: "Bash", tool_input: { command: "true" } });
    assert.deepEqual((await packed.acc(["status"])).participants, [],
      "a tool hook revived a completed owner without a genuine user turn");
    assert.deepEqual(await packed.findBinding(payload.session_id), oldBinding);

    const fresh = ownerFlags((await hook("UserPromptSubmit")).stdout, adapterId);
    assert.notEqual(fresh[1], first[1]);
    assert.notEqual(fresh[3], first[3]);
    const after = await packed.acc(["status"]);
    assert.equal(after.materialised, false);
    assert.equal(after.counts.live, 1);
    assert.equal(after.participants[0].sessionId, fresh[1]);
    assert.equal(after.participants[0].participantId, participantId);
    await packed.acc(["work", ...fresh, "--summary", "continued with fresh ownership"]);
    assert.equal((await packed.accError(["heartbeat", ...first]))?.code, 5);
    assert.deepEqual(ownerFlags((await hook("UserPromptSubmit")).stdout, adapterId), fresh);
    await hook("SessionEnd");
    assert.equal(await packed.findBinding(payload.session_id), null);
    assert.deepEqual((await packed.acc(["status"])).participants, []);
  });
}
