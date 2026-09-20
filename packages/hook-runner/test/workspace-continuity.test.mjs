import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { projectContextResult } from "@agents-can-communicate/adapter-sdk";
import { hermeticEnv } from "@agents-can-communicate/cli";
import { runHook } from "../src/runner.mjs";

const exec = promisify(execFile);
const platform = `${process.platform}-${process.arch}`;
// The adapter supplies a normalized hook contract. Storage, discovery, session
// lifecycle, projection and guard decisions all run through production code.
const adapter = {
  id: "fixture", client: { command: "fixture", certificationName: "fixture" },
  capabilities: { guards: { beforeWrite: true }, delivery: { nextTurn: true } },
  certification: { evidence: ["guards.beforeWrite", "delivery.nextTurn"].map(capability =>
    ({ client: "fixture", version: "1.0.0", platform, capability, result: "pass" })) },
  normalizeHook: payload => payload,
  injectOutcome: stdout => ({ stdout }), injectStartOwnerOutcome: stdout => ({ stdout }),
  renderContextResult: projectContextResult,
  denyOutcome: stderr => ({ stderr, exitCode: 2 }),
};

async function fixture(t, parentGit = false) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-room-continuity-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = path.join(root, "project");
  const web = path.join(parent, "web");
  const api = path.join(parent, "api");
  const plain = path.join(parent, "notes");
  const dataHome = path.join(root, "data");
  for (const directory of [parent, web, api, plain]) await mkdir(directory, { recursive: true });
  const git = (cwd, ...args) => exec("git", args, { cwd, env: hermeticEnv() });
  for (const directory of [web, api, ...(parentGit ? [parent] : [])]) await git(directory, "init", "--quiet");
  const hook = (kind, sessionId, cwd = parent, extra = {}, env = {}) => runHook({
    adapterId: adapter.id, adapters: { [adapter.id]: adapter }, dataHome,
    readProcessTable: async () => new Map(), probeClientVersion: async () => "1.0.0", platform,
    payload: { kind, sessionId, cwd, targets: [], ...extra }, env,
  });
  return { root, parent, web, api, plain, dataHome, hook, git };
}

for (const parentGit of [false, true]) {
  test(`sessions started in a ${parentGit ? "Git" : "plain"} parent keep one room in nested repositories`, async t => {
    const f = await fixture(t, parentGit);
    const first = await f.hook("sessionStart", "first");
    const second = await f.hook("sessionStart", "second");
    const recipient = second.sessions.find(p => p.sessionId === second.accSessionId).participantId;
    const message = await second.service.sendMessage({ sessionId: first.accSessionId,
      generation: first.generation, clientMessageId: "room-question", toParticipantIds: [recipient], kind: "question",
      obligation: "reply", subject: "Same room", body: "Keep the parent inbox" });
    for (const cwd of [f.web, f.api, f.plain]) {
      const turn = await f.hook("beforeTurn", "second", cwd);
      assert.equal(turn.failed, undefined, turn.reason);
      assert.deepEqual(turn.sessions.map(p => p.sessionId).sort(),
        [first.accSessionId, second.accSessionId].sort(), "cwd created another ACC room or owner");
      assert.match(turn.stdout, new RegExp(message.messageId), "the original inbox must remain reachable");
      assert.match(turn.stdout, new RegExp(`--session ${second.accSessionId} --generation ${second.generation}`));
      assert.ok(turn.stdout.includes(`--cwd '${f.parent}'`));
    }
    const compact = await f.hook("sessionStart", "second", f.api);
    assert.equal(compact.accSessionId, second.accSessionId);
    assert.equal(compact.generation, second.generation);
    const ended = await f.hook("sessionEnd", "second", f.web);
    assert.equal(ended.failed, undefined, ended.reason);
    assert.equal((await ended.service.locateSession(second.accSessionId)).record.state, "closed");
  });
}

test("a new native session started in a child repository keeps its own room", async t => {
  const f = await fixture(t);
  const parent = await f.hook("sessionStart", "parent");
  const child = await f.hook("sessionStart", "child", f.web);
  const turn = await f.hook("beforeTurn", "child", f.parent);
  assert.equal(turn.failed, undefined, turn.reason);
  assert.deepEqual(turn.sessions.map(p => p.sessionId), [child.accSessionId]);
  assert.ok(!turn.sessions.some(p => p.sessionId === parent.accSessionId));
});

test("relative writes in a nested repository still consult the parent room's claims", async t => {
  const f = await fixture(t);
  const holder = await f.hook("sessionStart", "holder");
  const writer = await f.hook("sessionStart", "writer");
  await writer.service.acquireClaim({ sessionId: holder.accSessionId, generation: holder.generation,
    resource: "file:web/src/**", mode: "exclusive", enforcement: "guarded", reason: "editing" });
  const result = await f.hook("beforeTool", "writer", f.web, { targets: ["src/widget.mjs"] });
  assert.equal(result.failed, undefined, result.reason);
  assert.equal(result.decision, "deny", "changing cwd bypassed an existing guarded claim");
});

test("a later workspace override does not move an already bound native session", async t => {
  const f = await fixture(t);
  const owner = await f.hook("sessionStart", "owner");
  const turn = await f.hook("beforeTurn", "owner", f.web, {}, { ACC_WORKSPACE_ROOT: f.web });
  assert.equal(turn.failed, undefined, turn.reason);
  assert.deepEqual(turn.sessions.map(p => p.sessionId), [owner.accSessionId]);
});

test("a changed startup config cannot silently rebind an existing session", async t => {
  const f = await fixture(t);
  await f.hook("sessionStart", "owner");
  await writeFile(path.join(f.parent, "acc.workspace.json"), JSON.stringify({
    schemaVersion: 1, workspaceId: "workspace_replacement", roots: ["."] }));
  const turn = await f.hook("beforeTurn", "owner", f.web);
  assert.equal(turn.exitCode, 0, "coordination failures must not stop the client");
  assert.equal(turn.failed, true);
  assert.match(turn.reason, /workspace.*changed/i);
  assert.equal(turn.stdout, "");
});

test("moving to another worktree keeps the room and repository-relative guard paths", async t => {
  const f = await fixture(t, true);
  await f.git(f.parent, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--allow-empty", "-m", "fixture");
  const linked = path.join(f.root, "linked");
  await f.git(f.parent, "worktree", "add", "-b", "linked", linked);
  const holder = await f.hook("sessionStart", "holder");
  const writer = await f.hook("sessionStart", "writer");
  await writer.service.acquireClaim({ sessionId: holder.accSessionId, generation: holder.generation,
    resource: "file:src/**", mode: "exclusive", enforcement: "guarded", reason: "editing" });
  const result = await f.hook("beforeTool", "writer", linked, { targets: ["src/widget.mjs"] });
  assert.equal(result.failed, undefined, result.reason);
  assert.equal(result.decision, "deny");
  const turn = await f.hook("beforeTurn", "writer", linked);
  assert.ok(turn.stdout.includes(`--cwd '${f.parent}'`));
  assert.match(turn.stdout, new RegExp(`--session ${writer.accSessionId}`));
});

test("resuming a closed native conversation from a child keeps the original room", async t => {
  const f = await fixture(t);
  const owner = await f.hook("sessionStart", "owner");
  const peer = await f.hook("sessionStart", "peer");
  await f.hook("sessionEnd", "owner");
  const resumed = await f.hook("sessionStart", "owner", f.web);
  assert.equal(resumed.failed, undefined, resumed.reason);
  assert.notEqual(resumed.accSessionId, owner.accSessionId, "closed generations must stay closed");
  assert.ok(resumed.sessions.some(p => p.sessionId === peer.accSessionId));
});

test("a missed startup is recovered on the first prompt and stays in that room", async t => {
  const f = await fixture(t);
  const first = await f.hook("beforeTurn", "owner");
  const next = await f.hook("beforeTurn", "owner", f.web);
  assert.equal(next.failed, undefined, next.reason);
  assert.equal(next.stdout, first.stdout);
});

test("a data-home symlink cannot put the room binding inside the project", async t => {
  const f = await fixture(t);
  const inside = path.join(f.parent, "runtime");
  await mkdir(inside);
  await symlink(inside, f.dataHome);
  const start = await f.hook("sessionStart", "owner");
  assert.equal(start.exitCode, 0);
  assert.equal(start.failed, true);
  await assert.rejects(access(path.join(inside, "acc", "native-workspaces")), { code: "ENOENT" });
});
