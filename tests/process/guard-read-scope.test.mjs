import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createCoordinationService } from "@agents-can-communicate/core";

import { createFakeClock, createFakeIds, createMemoryStore } from "../helpers/memory-store.mjs";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const acc = path.join(repo, "bin", "acc.mjs");
const hook = path.join(repo, "bin", "acc-hook.mjs");

/**
 * What guarding one write is allowed to cost.
 *
 * The guard ran `collectStatus`, which reads every record the workspace holds,
 * in front of every file an agent writes. Measured at about 1.4ms per stored
 * record: a workspace carrying 400 messages took 207ms to answer "is this file
 * claimed", and the cost grows with every message ever sent. The hook's budget
 * is five seconds, and past it the hook fails open - so a workspace that had
 * been used enough would stop enforcing claims, silently, with `acc status`
 * still reporting `protection guarded`.
 *
 * Sessions and claims are bounded by what is live. Messages, receipts, tasks and
 * events are bounded by nothing, and none of them decides whether a write is
 * allowed. The same read now takes 2ms and does not grow.
 *
 * These assert the shape rather than the clock: a timing test on shared CI
 * measures the machine.
 */
function spyStore() {
  const clock = createFakeClock("2026-08-23T00:00:00.000Z");
  const store = createMemoryStore({ clock, ids: createFakeIds(), workspaceId: "workspace_a" });
  const asked = [];
  const wrapped = { ...store,
    snapshot: (workspaceId, options) => {
      asked.push(options?.kinds ?? "everything");
      return store.snapshot(workspaceId, options);
    } };
  return { asked, clock,
    service: createCoordinationService({ store: wrapped, clock, ids: createFakeIds() }) };
}

const UNBOUNDED = Object.freeze(["message", "receipt", "task", "event", "decision", "handoff"]);

test("the guard's read asks for nothing that grows without limit", async () => {
  const { asked, service } = spyStore();

  await service.guardState({ workspaceId: "workspace_a" });

  assert.equal(asked.length, 1);
  assert.notEqual(asked[0], "everything", "the guard still reads the whole store");
  for (const kind of UNBOUNDED) {
    assert.equal(asked[0].includes(kind), false,
      `the guard reads every ${kind} the workspace has ever held`);
  }
});

test("the read a person asks for is still the whole store", async () => {
  const { asked, service } = spyStore();

  await service.collectStatus({ workspaceId: "workspace_a" });

  // `acc status` reports counts of everything, and narrowing it would be
  // answering a different question than the one asked.
  assert.deepEqual(asked, ["everything"]);
});

test("a kinds-scoped snapshot returns those kinds and leaves the rest empty", async () => {
  const { service } = spyStore();
  const session = await service.openSession({ workspaceId: "workspace_a",
    participantId: "solo", displayName: "solo", harness: "cli",
    heartbeatCadenceMs: 30_000,
    descriptor: { id: "workspace_a", roots: ["/tmp/x"], source: "directory" } });
  await service.sendMessage({ sessionId: session.sessionId, generation: session.generation,
    toParticipantIds: ["solo"], type: "note", subject: "s", body: "b",
    descriptor: { id: "workspace_a", roots: ["/tmp/x"], source: "directory" } });

  const narrow = await service.store.snapshot("workspace_a",
    { kinds: ["workspace", "session", "claim"] });
  const whole = await service.store.snapshot("workspace_a");

  assert.equal(whole.messages.length, 1);
  assert.deepEqual(narrow.messages, [], "a kind nobody asked for was read anyway");
  assert.equal(narrow.sessions.length, whole.sessions.length);
});

/** The narrowing must not have changed what the guard decides. */
async function workspace(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-scope-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = path.join(base, "project");
  await run("mkdir", ["-p", project]);
  const env = { ...process.env, ACC_DATA_HOME: path.join(base, "data"),
    GIT_DIR: "", GIT_WORK_TREE: "" };
  const attach = async participant => {
    const child = run(process.execPath, [hook, "codex"],
      { env: { ...env, ACC_PARTICIPANT: participant } });
    child.child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart",
      session_id: participant, cwd: project, source: "startup" }));
    await child;
  };
  const write = participant => {
    const child = run(process.execPath, [hook, "codex"],
      { env: { ...env, ACC_PARTICIPANT: participant } });
    child.child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse",
      session_id: participant, cwd: project, tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Update File: src/a.mjs\n@@\n-a\n+b\n"
        + "*** End Patch" } }));
    return child.then(() => "allow", () => "deny");
  };
  const cli = (args, who) => run(process.execPath, [acc, ...args, "--cwd", project],
    { env: { ...env, CLAUDE_CODE_SESSION_ID: who } });
  return { project, env, attach, write, cli };
}

test("a claim is still enforced in a workspace full of messages", async t => {
  const place = await workspace(t);
  await place.attach("holder");
  await place.attach("writer");
  await place.cli(["claim", "--resource", "file:src/**", "--enforcement", "guarded",
    "--reason", "editing"], "holder");
  for (let index = 0; index < 20; index += 1) {
    await place.cli(["message", "--to", "writer", "--subject", `note ${index}`,
      "--body", "x".repeat(100)], "holder");
  }

  // The records the guard no longer reads are exactly the ones piled up here.
  assert.equal(await place.write("writer"), "deny");
});

test("a claim is enforced before the workspace has materialised", async t => {
  const place = await workspace(t);
  await place.attach("holder");
  await place.attach("writer");

  // Sessions live in the ephemeral area until something durable is written, and
  // a narrow read that forgot them would guard nothing at the very start.
  await place.cli(["claim", "--resource", "file:src/**", "--enforcement", "guarded",
    "--reason", "editing"], "holder");

  assert.equal(await place.write("writer"), "deny");
  assert.equal(await place.write("holder"), "allow");
});
