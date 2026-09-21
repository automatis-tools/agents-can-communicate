import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { ANTIGRAVITY_HOOK_EVENTS, ANTIGRAVITY_INERT_EVENTS, STOP_CONTINUATION_CEILING,
  injectResponse, normalizeAntigravityHook, stopOutcome, stopResponse }
  from "../src/hooks.mjs";

const captured = async name => JSON.parse(await readFile(
  new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));

test("the event comes from the argument, because the payload carries no name", async () => {
  const payload = await captured("SessionStart-1.2.7");
  assert.equal(payload.hook_event_name, undefined,
    "the fixture would have to change for this client to name its own event");

  const event = normalizeAntigravityHook(payload, { args: ["SessionStart"] });

  assert.equal(event.kind, "sessionStart");
  assert.equal(event.sessionId, payload.conversationId);
  assert.equal(event.cwd, payload.workspacePaths[0]);
  assert.equal(event.model, "gemini-3.8-flash-high");
});

test("PreInvocation and PostInvocation are told apart only by the argument", async () => {
  // The two envelopes are byte-identical for the same invocation, so an adapter
  // that read the payload for the event would answer the wrong one every time.
  const pre = await captured("PreInvocation-1.2.7");
  const post = await captured("PostInvocation-1.2.7");
  assert.deepEqual(pre, post, "the capture stopped being ambiguous; revisit the argument rule");

  assert.equal(normalizeAntigravityHook(pre, { args: ["PreInvocation"] }).kind, "beforeTurn");
  assert.equal(normalizeAntigravityHook(post, { args: ["PostInvocation"] }).kind, "other");
});

test("Stop normalises to the end of a turn", async () => {
  const event = normalizeAntigravityHook(await captured("Stop-1.2.7"), { args: ["Stop"] });
  assert.equal(event.kind, "turnEnd");
});

test("an event name this client silently drops is refused rather than answered", async () => {
  const payload = await captured("SessionStart-1.2.7");
  for (const inert of ANTIGRAVITY_INERT_EVENTS) {
    assert.throws(() => normalizeAntigravityHook(payload, { args: [inert] }),
      error => error.code === EXIT.DATA,
      `${inert} does not load on this client and must not be normalised`);
  }
});

test("a payload without a conversation or a workspace is refused", () => {
  assert.throws(() => normalizeAntigravityHook({ modelName: "x" }, { args: ["SessionStart"] }),
    error => error.code === EXIT.DATA);
  assert.throws(() => normalizeAntigravityHook(
    { conversationId: "c", workspacePaths: [] }, { args: ["SessionStart"] }),
  error => error.code === EXIT.DATA);
});

test("the four loading events are exactly the ones observed", () => {
  assert.deepEqual([...ANTIGRAVITY_HOOK_EVENTS],
    ["SessionStart", "PreInvocation", "PostInvocation", "Stop"]);
});

test("context reaches the model through injectSteps, not a bare string", () => {
  assert.deepEqual(injectResponse("peer text"),
    { injectSteps: [{ ephemeralMessage: "peer text" }] });
  assert.deepEqual(injectResponse(""), {}, "an empty injection must stay silent");
});

test("Stop continues the turn only while the adapter's own ceiling allows it", async () => {
  const first = await captured("Stop-1.2.7");
  const second = await captured("Stop-continued-1.2.7");
  assert.equal(first.executionNum, 0);
  assert.equal(second.executionNum, 1);

  assert.deepEqual(stopResponse({ reason: "a peer is waiting", executionNum: 0 }),
    { decision: "continue", reason: "a peer is waiting" });
  assert.deepEqual(
    stopResponse({ reason: "a peer is waiting", executionNum: STOP_CONTINUATION_CEILING }),
    {}, "the adapter must stop asking before the client's own cap does");
  assert.ok(STOP_CONTINUATION_CEILING >= 1);
});

test("Stop permits shutdown whenever anything is missing or wrong", () => {
  // Fail open: a hook error, a timeout, or an unreachable store all arrive here
  // as an absent reason, and every one of them must end in a normal turn.
  for (const input of [undefined, {}, { reason: "" }, { reason: null, executionNum: 0 },
    { reason: "x" }, { reason: "x", executionNum: "not a number" },
    { reason: "x", executionNum: -1 }]) {
    assert.deepEqual(stopResponse(input), {},
      `${JSON.stringify(input)} must not hold the turn open`);
  }
});

test("a Stop outcome never fails the hook", () => {
  const held = stopOutcome({ reason: "a peer is waiting", executionNum: 0 });
  assert.equal(held.exitCode, 0);
  assert.equal(JSON.parse(held.stdout).decision, "continue");

  const released = stopOutcome({ executionNum: 99 });
  assert.equal(released.exitCode, 0);
  assert.equal(released.stdout, "", "permitting shutdown must print nothing at all");
});

test("a turn with no open workspace is refused by name, not as a generic bad payload", async () => {
  // Captured from an ordinary `agy -p` turn: workspacePaths is empty unless the
  // session has an open workspace. The original fixtures were taken with
  // --add-dir, which populates it, so this case was invisible until a real turn
  // ran. There is nothing else in the payload that names the user's project -
  // transcriptPath and artifactDirectoryPath both point inside the client's own
  // brain directory, one per conversation - and the hook process does not
  // inherit the client's directory either. Refusing is right; refusing
  // anonymously is what made it look like nothing was installed.
  const payload = await captured("SessionStart-no-workspace-1.2.7");
  assert.deepEqual(payload.workspacePaths, []);

  assert.throws(() => normalizeAntigravityHook(payload, { args: ["SessionStart"] }),
    error => error.code === EXIT.DATA
      && error.details?.reasonCode === "antigravity_no_open_workspace"
      && /--add-dir|open workspace/.test(error.message),
    "an empty workspacePaths must be reported as its own cause");
});

test("the conversation's own brain directory is never used as a workspace", async () => {
  // It is inside ~/.gemini, it is per-conversation, and adopting it would give
  // every conversation a private ACC workspace inside the client's state - so
  // two agents in the same project would never see each other.
  const payload = await captured("SessionStart-no-workspace-1.2.7");
  try {
    const event = normalizeAntigravityHook(payload, { args: ["SessionStart"] });
    assert.fail(`normalised to ${event.cwd} instead of refusing`);
  } catch (error) {
    assert.equal(error.code, EXIT.DATA);
  }
});

test("a turn in the TUI names its project, at every invocation of the turn", async () => {
  // The ordinary interactive case: the Antigravity TUI started in a project
  // directory with no --add-dir. workspacePaths is populated, so it is only a
  // print-mode `agy -p` without a workspace that leaves the hook nothing. And
  // PreInvocation fires once per model invocation - three here within one user
  // turn - which is why a peer message queued mid-turn is offered at the next
  // invocation rather than at the next prompt.
  const { payloads } = await captured("PreInvocation-tui-1.2.7");
  assert.deepEqual(payloads.map(payload => payload.invocationNum), [0, 1, 2]);

  for (const payload of payloads) {
    const event = normalizeAntigravityHook(payload, { args: ["PreInvocation"] });
    assert.equal(event.kind, "beforeTurn");
    assert.equal(event.cwd, payload.workspacePaths[0]);
    // One conversation, one ACC session, across every invocation of the turn.
    assert.equal(event.sessionId, payloads[0].conversationId);
  }
});
