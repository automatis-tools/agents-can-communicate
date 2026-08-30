import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalTarget, covers, resourceFor, runHook } from "../src/runner.mjs";

// Two adapters whose deny shapes disagree, because that disagreement is the
// point: the runner must speak each client's own contract, and a shape borrowed
// from the other one denies nothing at all.
const kimi = {
  id: "kimi",
  client: { command: "kimi", versionArgs: ["--version"] },
  normalizeHook: payload => payload,
  denyOutcome: reason => ({ stdout: JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: reason } }), stderr: "", exitCode: 0 }),
  injectOutcome: context => ({ stdout: context, stderr: "", exitCode: 0 }),
  renderContext: sync => `${sync.roster?.length ?? 0} peers`,
};

const gemini = {
  id: "gemini_cli",
  normalizeHook: payload => payload,
  denyOutcome: reason => ({ stdout: JSON.stringify({ decision: "block", reason }),
    stderr: "", exitCode: 0 }),
  injectOutcome: context => ({ stdout: JSON.stringify({ hookSpecificOutput: {
    hookEventName: "BeforeAgent", additionalContext: context } }),
    stderr: "", exitCode: 0 }),
  renderContext: sync => `${sync.roster?.length ?? 0} peers`,
};

const ADAPTERS = { kimi, gemini_cli: gemini };

async function workspace(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-hook-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-data-")));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));
  return { root, dataHome };
}

const event = (kind, extra = {}) => ({ kind, sessionId: "harness-session-1",
  cwd: extra.cwd, model: null, parentSessionId: null, tool: null, targets: [], ...extra });

// A test that reads the machine's live process table is a test whose result
// depends on what happens to be running, not on the hook behaviour this file
// is about. Every call site below defaults to this, so `sessionStart` resolves
// pid to null deterministically; the two tests that care about pid resolution
// supply their own table and override it.
const noProcessTable = async () => new Map();

const run = (adapterId, payload, { root, dataHome }, options = {}) =>
  runHook({ adapterId, payload: { ...payload, cwd: payload.cwd ?? root },
    adapters: ADAPTERS, dataHome, readProcessTable: noProcessTable, ...options });

test("sessionStart attaches, and a later hook reuses that same session", async t => {
  const place = await workspace(t);

  const started = await run("kimi", event("sessionStart"), place);
  assert.equal(started.exitCode, 0);

  // The attaching process is gone by the time the next hook runs. If the
  // binding did not survive, this would open a second session and orphan the
  // first - which looks like it is working right up until presence is wrong.
  const beat = await run("kimi", event("heartbeat"), place);

  assert.equal(beat.exitCode, 0);
  assert.equal(beat.sessions.length, 1);
  assert.equal(beat.sessions[0].sessionId, started.accSessionId);
});

test("a heartbeat with no prior attach does not invent a session", async t => {
  const place = await workspace(t);

  const beat = await run("kimi", event("heartbeat"), place);

  assert.equal(beat.exitCode, 0, "a missing binding must not break the session");
  assert.deepEqual(beat.sessions, []);
});

test("beforeTool denies a write into another session's guarded claim", async t => {
  const place = await workspace(t);
  const peer = await run("kimi", event("sessionStart",
    { sessionId: "peer-session" }), place);
  await peer.service.acquireClaim({ sessionId: peer.accSessionId,
    generation: peer.generation, resource: "file:packages/core/**",
    mode: "exclusive", enforcement: "guarded", reason: "porting the store" });

  await run("kimi", event("sessionStart"), place);
  const guarded = await run("kimi", event("beforeTool", { tool: "Write",
    targets: [path.join(place.root, "packages/core/store.mjs")] }), place);

  assert.equal(guarded.decision, "deny");
  // The client's own shape, not a portable-looking one.
  assert.equal(JSON.parse(guarded.stdout).hookSpecificOutput.permissionDecision, "deny");
  // The reason names the resource and who holds it, so the blocked agent can
  // say something useful instead of retrying blindly.
  const said = JSON.parse(guarded.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(said, /file:packages\/core\/\*\*/);
  assert.equal(said.includes(peer.accSessionId), true, "the reason does not name the owner");
});

test("each client is denied in its own shape", async t => {
  const place = await workspace(t);
  const peer = await run("kimi", event("sessionStart", { sessionId: "peer" }), place);
  await peer.service.acquireClaim({ sessionId: peer.accSessionId,
    generation: peer.generation, resource: "file:src/**", mode: "exclusive",
    enforcement: "guarded", reason: "held" });
  await run("gemini_cli", event("sessionStart"), place);

  const denied = await run("gemini_cli", event("beforeTool", { tool: "write_file",
    targets: [path.join(place.root, "src/a.mjs")] }), place);

  // Gemini ignores the shape Kimi acts on. Emitting the wrong one here would
  // let every guarded write through while reporting protection.
  assert.equal(JSON.parse(denied.stdout).decision, "block");
});

test("a session is not blocked by its own claim", async t => {
  const place = await workspace(t);
  const mine = await run("kimi", event("sessionStart"), place);
  await mine.service.acquireClaim({ sessionId: mine.accSessionId,
    generation: mine.generation, resource: "file:src/**", mode: "exclusive",
    enforcement: "guarded", reason: "mine" });

  const allowed = await run("kimi", event("beforeTool", { tool: "Write",
    targets: [path.join(place.root, "src/a.mjs")] }), place);

  assert.equal(allowed.decision, "allow");
});

test("an advisory claim does not block, it informs", async t => {
  const place = await workspace(t);
  const peer = await run("kimi", event("sessionStart", { sessionId: "peer" }), place);
  await peer.service.acquireClaim({ sessionId: peer.accSessionId,
    generation: peer.generation, resource: "file:src/**", mode: "exclusive",
    enforcement: "advisory", reason: "just looking" });
  await run("kimi", event("sessionStart"), place);

  const allowed = await run("kimi", event("beforeTool", { tool: "Write",
    targets: [path.join(place.root, "src/a.mjs")] }), place);

  // Enforcement is declared per claim. Blocking on an advisory claim would
  // enforce something its owner explicitly did not ask for.
  assert.equal(allowed.decision, "allow");
});

test("a command the guard cannot read declares no target, so nothing matches", async t => {
  const place = await workspace(t);
  const peer = await run("kimi", event("sessionStart", { sessionId: "peer" }), place);
  await peer.service.acquireClaim({ sessionId: peer.accSessionId,
    generation: peer.generation, resource: "file:src/**", mode: "exclusive",
    enforcement: "guarded", reason: "held" });
  await run("kimi", event("sessionStart"), place);

  const allowed = await run("kimi", event("beforeTool", { tool: "Bash", targets: [] }), place);

  // Honest rather than convenient: a command whose write positions the adapter
  // could not read arrives with no targets, and the runner does not invent one.
  // The commands it can read arrive with targets and are matched like any edit.
  assert.equal(allowed.decision, "allow");
  assert.equal(allowed.unguarded, true);
});

test("a path outside the workspace is not silently treated as inside it", async t => {
  const place = await workspace(t);
  const peer = await run("kimi", event("sessionStart", { sessionId: "peer" }), place);
  await peer.service.acquireClaim({ sessionId: peer.accSessionId,
    generation: peer.generation, resource: "file:src/**", mode: "exclusive",
    enforcement: "guarded", reason: "held" });
  await run("kimi", event("sessionStart"), place);

  const allowed = await run("kimi", event("beforeTool", { tool: "Write",
    targets: ["/etc/src/a.mjs"] }), place);

  // /etc/src/a.mjs is not this workspace's src/. Relativising it carelessly
  // would produce "src/a.mjs" and block a write the claim never covered.
  assert.equal(allowed.decision, "allow");
});

test("beforeTurn injects peer context, and says nothing when alone", async t => {
  const place = await workspace(t);
  await run("kimi", event("sessionStart"), place);

  const solo = await run("kimi", event("beforeTurn"), place);
  assert.equal(solo.stdout, "", "a solo session narrated the absence of peers");

  await run("kimi", event("sessionStart", { sessionId: "peer" }), place);
  const withPeer = await run("kimi", event("beforeTurn"), place);

  assert.equal(withPeer.stdout.length > 0, true);
  assert.equal(withPeer.exitCode, 0);
});

test("sessionEnd closes the session and drops the binding", async t => {
  const place = await workspace(t);
  const started = await run("kimi", event("sessionStart"), place);

  await run("kimi", event("sessionEnd"), place);
  const after = await run("kimi", event("heartbeat"), place);

  assert.equal(after.exitCode, 0);
  assert.deepEqual(after.sessions, [], "the binding outlived the session it named");
  assert.equal(typeof started.accSessionId, "string");
});

test("an internal failure never breaks the session it is hooked into", async t => {
  const place = await workspace(t);
  const broken = { ...kimi, normalizeHook: () => { throw new Error("boom"); } };

  const result = await runHook({ adapterId: "kimi", payload: event("beforeTool"),
    adapters: { kimi: broken }, dataHome: place.dataHome,
    readProcessTable: noProcessTable });

  // A coordination tool must never be the reason someone's session stops
  // working. Failing open is the only acceptable direction here.
  assert.equal(result.exitCode, 0);
  assert.equal(result.decision, "allow");
  assert.equal(result.failed, true);
});

test("an unknown adapter fails open rather than guessing a contract", async t => {
  const place = await workspace(t);

  const result = await run("nonexistent", event("beforeTool"), place);

  assert.equal(result.exitCode, 0);
  assert.equal(result.decision, "allow");
  assert.equal(result.failed, true);
});

test("nothing about the conversation is written anywhere", async t => {
  const place = await workspace(t);
  await run("kimi", event("sessionStart",
    { prompt: "a secret plan", transcript_path: "/tmp/t.jsonl" }), place);

  const beat = await run("kimi", event("heartbeat"), place);

  const stored = JSON.stringify(beat.sessions);
  assert.equal(stored.includes("secret plan"), false);
  assert.equal(stored.includes("t.jsonl"), false);
});

test("path mapping refuses anything that is not inside the workspace", () => {
  // Checked directly, because the end-to-end version of this proves nothing:
  // an escaping path relativises to `../..` segments that match no claim
  // anyway, so the test passes whether the guard is there or not.
  assert.equal(resourceFor("/ws", "/ws/src/a.mjs"), "file:src/a.mjs");
  assert.equal(resourceFor("/ws", "src/a.mjs"), "file:src/a.mjs");

  assert.equal(resourceFor("/ws", "/etc/passwd"), null);
  // A sibling whose name merely starts with the root's. A `startsWith` check -
  // the obvious way to write this - would call it inside.
  assert.equal(resourceFor("/ws", "/ws-backup/src/a.mjs"), null);
  assert.equal(resourceFor("/ws", "/ws"), null);
});

test("claim coverage is per segment, not by string prefix", () => {
  // `file:srcx/a.mjs` starts with `src` as text and is a different directory.
  assert.equal(covers("file:src/**", "file:src/a.mjs"), true);
  assert.equal(covers("file:src/**", "file:src/deep/a.mjs"), true);
  assert.equal(covers("file:src/**", "file:src"), true);
  assert.equal(covers("file:src/**", "file:srcx/a.mjs"), false);
  assert.equal(covers("file:src/a.mjs", "file:src/a.mjs"), true);
  assert.equal(covers("file:src/a.mjs", "file:src/b.mjs"), false);
});

test("a client that denies by exit code is served that way, not with JSON", async t => {
  const place = await workspace(t);
  // Codex has no structured reply at all: it denies by exiting 2 with the
  // reason on stderr. A runner that only knows how to print JSON would report
  // protection while letting every guarded write through on that client.
  const codex = { id: "codex", normalizeHook: payload => payload,
    denyOutcome: reason => ({ stdout: "", stderr: reason, exitCode: 2 }),
    renderContext: () => "" };
  const adapters = { ...ADAPTERS, codex };

  const peer = await runHook({ adapterId: "kimi", adapters, dataHome: place.dataHome,
    readProcessTable: noProcessTable,
    payload: event("sessionStart", { sessionId: "peer", cwd: place.root }) });
  await peer.service.acquireClaim({ sessionId: peer.accSessionId,
    generation: peer.generation, resource: "file:src/**", mode: "exclusive",
    enforcement: "guarded", reason: "held" });
  await runHook({ adapterId: "codex", adapters, dataHome: place.dataHome,
    readProcessTable: noProcessTable,
    payload: event("sessionStart", { cwd: place.root }) });

  const denied = await runHook({ adapterId: "codex", adapters, dataHome: place.dataHome,
    readProcessTable: noProcessTable,
    payload: event("beforeTool", { tool: "apply_patch", cwd: place.root,
      targets: [path.join(place.root, "src/a.mjs")] }) });

  assert.equal(denied.decision, "deny");
  assert.equal(denied.exitCode, 2, "the deny did not reach the client");
  assert.equal(denied.stdout, "");
  assert.match(denied.stderr, /file:src/);
});

test("attach declares what the adapter proved, not that it is an adapter", async t => {
  const place = await workspace(t);
  const guarding = { ...kimi, capabilities: { guards: { beforeWrite: true },
    lifecycle: { sessionEnd: true } } };
  const blind = { ...kimi, id: "blind",
    capabilities: { guards: { beforeWrite: false }, lifecycle: { sessionEnd: false } } };
  const adapters = { kimi: guarding, blind };

  await runHook({ adapterId: "kimi", adapters, dataHome: place.dataHome,
    readProcessTable: noProcessTable,
    payload: event("sessionStart", { sessionId: "a", cwd: place.root }) });
  const after = await runHook({ adapterId: "blind", adapters, dataHome: place.dataHome,
    readProcessTable: noProcessTable,
    payload: event("sessionStart", { sessionId: "b", cwd: place.root }) });

  const byHarness = Object.fromEntries(after.sessions.map(s => [s.harness, s]));
  assert.equal(byHarness.kimi.enforcement, "guarded");
  assert.equal(byHarness.kimi.lifecycle, "managed");
  // Kimi Code fires no SessionEnd and Codex cannot guard a shell edit; both are
  // real cases, and both have to read as the weaker thing on the roster.
  assert.equal(byHarness.blind.enforcement, "advisory");
  assert.equal(byHarness.blind.lifecycle, "manual");
});

test("the turn context names claims this session cannot be stopped from breaking",
  async t => {
    const place = await workspace(t);
    const peer = await run("kimi", event("sessionStart", { sessionId: "peer" }), place);
    await peer.service.acquireClaim({ sessionId: peer.accSessionId,
      generation: peer.generation, resource: "file:src/**", mode: "exclusive",
      enforcement: "guarded", reason: "porting" });

    // A session whose harness cannot guard writes: a Codex model that edits
    // through the shell, or an MCP client. Nothing will intercept it, so the
    // only protection left is telling it before the turn.
    const unguarded = { ...kimi, id: "unguarded",
      capabilities: { guards: { beforeWrite: false }, lifecycle: { sessionEnd: false } },
      renderContext: sync => (sync.claims ?? [])
        .map(c => `${c.resource}|${c.enforceable}`).join(" ") };
    const adapters = { ...ADAPTERS, unguarded };

    await runHook({ adapterId: "unguarded", adapters, dataHome: place.dataHome,
      readProcessTable: noProcessTable,
      payload: event("sessionStart", { cwd: place.root }) });
    const turn = await runHook({ adapterId: "unguarded", adapters, dataHome: place.dataHome,
      readProcessTable: noProcessTable,
      payload: event("beforeTurn", { cwd: place.root }) });

    assert.match(turn.stdout, /file:src\/\*\*/);
    assert.match(turn.stdout, /\|false/, "the session was not told it is unenforced");
  });

test("a guarded session is told about the claim, and that it is enforced", async t => {
  const place = await workspace(t);
  const peer = await run("kimi", event("sessionStart", { sessionId: "peer" }), place);
  await peer.service.acquireClaim({ sessionId: peer.accSessionId,
    generation: peer.generation, resource: "file:src/**", mode: "exclusive",
    enforcement: "guarded", reason: "porting" });

  const guarding = { ...kimi, id: "guarding",
    capabilities: { guards: { beforeWrite: true }, lifecycle: { sessionEnd: true } },
    renderContext: sync => (sync.claims ?? [])
      .map(c => `${c.resource}|${c.enforceable}`).join(" ") };
  const adapters = { ...ADAPTERS, guarding };

  await runHook({ adapterId: "guarding", adapters, dataHome: place.dataHome,
    readProcessTable: noProcessTable,
    payload: event("sessionStart", { cwd: place.root }) });
  const turn = await runHook({ adapterId: "guarding", adapters, dataHome: place.dataHome,
    readProcessTable: noProcessTable,
    payload: event("beforeTurn", { cwd: place.root }) });

  assert.match(turn.stdout, /\|true/);
});

test("a session is not warned about its own claim", async t => {
  const place = await workspace(t);
  // An adapter that actually renders claims. The default mock renders only the
  // roster, so asserting the absence of a claim through it would prove nothing
  // whatever the runner did.
  const rendering = { ...kimi, id: "rendering",
    renderContext: sync => (sync.claims ?? []).map(c => c.resource).join(" ") };
  const adapters = { ...ADAPTERS, rendering };

  const mine = await runHook({ adapterId: "rendering", adapters,
    dataHome: place.dataHome, readProcessTable: noProcessTable,
    payload: event("sessionStart", { cwd: place.root }) });
  await mine.service.acquireClaim({ sessionId: mine.accSessionId,
    generation: mine.generation, resource: "file:src/**", mode: "exclusive",
    enforcement: "guarded", reason: "mine" });
  await runHook({ adapterId: "rendering", adapters, dataHome: place.dataHome,
    readProcessTable: noProcessTable,
    payload: event("sessionStart", { sessionId: "peer", cwd: place.root }) });

  const turn = await runHook({ adapterId: "rendering", adapters,
    dataHome: place.dataHome, readProcessTable: noProcessTable,
    payload: event("beforeTurn", { cwd: place.root }) });

  // Telling a session to avoid the thing it deliberately reserved would be
  // exactly backwards.
  assert.doesNotMatch(turn.stdout, /file:src/);
});

test("an advisory claim is passed through as advisory, not as a block", async t => {
  const place = await workspace(t);
  const peer = await run("kimi", event("sessionStart", { sessionId: "peer" }), place);
  await peer.service.acquireClaim({ sessionId: peer.accSessionId,
    generation: peer.generation, resource: "file:src/**", mode: "exclusive",
    enforcement: "advisory", reason: "just asking" });

  // A session that genuinely can be guarded. The guard still will not block an
  // advisory claim, so telling this session its edits are blocked would be an
  // announcement of something that never happens.
  const guarding = { ...kimi, id: "guarding",
    capabilities: { guards: { beforeWrite: true }, lifecycle: { sessionEnd: true } },
    renderContext: sync => (sync.claims ?? [])
      .map(c => `${c.resource}|${c.enforcement}|${c.enforceable}`).join(" ") };
  const adapters = { ...ADAPTERS, guarding };

  await runHook({ adapterId: "guarding", adapters, dataHome: place.dataHome,
    readProcessTable: noProcessTable,
    payload: event("sessionStart", { cwd: place.root }) });
  const turn = await runHook({ adapterId: "guarding", adapters, dataHome: place.dataHome,
    readProcessTable: noProcessTable,
    payload: event("beforeTurn", { cwd: place.root }) });

  assert.match(turn.stdout, /file:src\/\*\*\|advisory\|true/);
});

/**
 * The leaf of a guarded path is usually the file the tool call is about to
 * create, so resolution has to work on a path that does not exist yet. These
 * drive an injected realpath rather than the filesystem, because the branch
 * that matters - how far up the walk goes - is otherwise invisible.
 */
const fakeRealpath = existing => async target => {
  if (existing.has(target)) return existing.get(target);
  const error = new Error(`ENOENT: ${target}`);
  error.code = "ENOENT";
  throw error;
};

test("a path whose leaf does not exist resolves through its deepest real parent", async () => {
  const resolve = fakeRealpath(new Map([["/link/project", "/real/project"]]));

  assert.equal(await canonicalTarget(resolve, "/link/project/src/store/index.mjs"),
    "/real/project/src/store/index.mjs");
});

test("an existing path resolves outright", async () => {
  const resolve = fakeRealpath(new Map([["/link/a.mjs", "/real/a.mjs"]]));

  assert.equal(await canonicalTarget(resolve, "/link/a.mjs"), "/real/a.mjs");
});

test("nothing resolvable leaves the path as given rather than inventing one", async () => {
  // Not a silent empty string: `resourceFor` still gets a real path to judge,
  // and rejects it if it is outside the workspace.
  assert.equal(await canonicalTarget(fakeRealpath(new Map()), "/nowhere/at/all.mjs"),
    "/nowhere/at/all.mjs");
});

test("an error that is not absence stops the walk instead of climbing past it", async () => {
  // EACCES on a parent means the answer is unknown, not "keep going until
  // something answers" - climbing would resolve some unrelated ancestor and
  // graft the rest onto it.
  const resolve = async () => {
    const error = new Error("EACCES");
    error.code = "EACCES";
    throw error;
  };

  assert.equal(await canonicalTarget(resolve, "/guarded/src/a.mjs"), "/guarded/src/a.mjs");
});

test("a session opened by a hook names the client process", async t => {
  const place = await workspace(t);
  // The walk starts at this test process, so the synthetic table has to be
  // rooted there. Naming `kimi` two hops up proves the shell in between is
  // stepped over, which is the case a real machine actually produces.
  const table = new Map([
    [process.pid, { ppid: 900, comm: "node" }],
    [900, { ppid: 100, comm: "/bin/zsh" }],
    [100, { ppid: 1, comm: "kimi" }],
  ]);

  const started = await run("kimi", event("sessionStart"), place,
    { readProcessTable: async () => table });

  const record = await started.service.store.ephemeral.get("session",
    started.accSessionId);
  assert.equal(record.pid, 100);
});

test("a session still opens when the client cannot be named", async t => {
  const place = await workspace(t);

  const started = await run("kimi", event("sessionStart"), place,
    { readProcessTable: async () => new Map() });

  const record = await started.service.store.ephemeral.get("session",
    started.accSessionId);
  // Null, not a failure: an unnameable client must never stop a session opening.
  assert.equal(started.exitCode, 0);
  assert.equal(record.pid, null);
});
