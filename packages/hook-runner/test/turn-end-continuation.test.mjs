import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runHook } from "../src/runner.mjs";

// A client whose end-of-turn hook can hold the turn open, and carries text to
// the model when it does - Antigravity CLI's Stop, answered with
// {"decision":"continue","reason"}. The runner's part is deciding whether there
// is anything worth continuing for; the adapter's part is the shape, and its
// own ceiling, which it reads from the payload the runner hands back to it.
const platform = `${process.platform}-${process.arch}`;
const echo = sync => ({
  text: (sync.messages ?? []).map(message => `id ${message.messageId} | ${message.body}`)
    .join("\n"),
  offeredMessageIds: (sync.messages ?? []).map(message => message.messageId),
  includedAttentionIds: [],
});
const adapter = ({ continues = true } = {}) => ({
  id: "cont",
  client: { command: "cont", certificationName: "cont", versionArgs: ["--version"] },
  capabilities: { delivery: { nextTurn: true } },
  certification: { evidence: [{ client: "cont", version: "1.0.0", platform,
    capability: "delivery.nextTurn", result: "pass" }] },
  normalizeHook: payload => payload,
  injectOutcome: text => ({ stdout: text, stderr: "", exitCode: 0 }),
  renderContext: sync => echo(sync).text,
  renderContextResult: sync => echo(sync),
  ...(continues ? { continueTurnOutcome: ({ reason, payload }) =>
    (payload.executionNum ?? 0) >= 1 ? { stdout: "", stderr: "", exitCode: 0 }
      : { stdout: `${JSON.stringify({ decision: "continue", reason })}\n`, stderr: "",
        exitCode: 0 } } : {}),
});

async function workspace(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-turnend-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-turnend-data-")));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));
  return { root, dataHome };
}

const event = (kind, root, extra = {}) => ({ kind, sessionId: "harness-session-1", cwd: root,
  model: null, parentSessionId: null, tool: null, targets: [], ...extra });

function harness(place, options) {
  const cont = adapter(options);
  return (payload) => runHook({ adapterId: "cont", payload, adapters: { cont },
    dataHome: place.dataHome, readProcessTable: async () => new Map(),
    probeClientVersion: async () => "1.0.0", platform });
}

async function withPeerMessage(t, options) {
  const place = await workspace(t);
  const invoke = harness(place, options);
  const recipient = await invoke(event("sessionStart", place.root));
  const peer = await invoke(event("sessionStart", place.root, { sessionId: "peer-session" }));
  const participantId = recipient.sessions
    .find(session => session.sessionId === recipient.accSessionId).participantId;
  const message = await peer.service.sendMessage({ sessionId: peer.accSessionId,
    generation: peer.generation, clientMessageId: "client_turn_end",
    toParticipantIds: [participantId], kind: "question", obligation: "reply",
    subject: "At the end of your turn", body: "arrived while you were finishing" });
  const receipt = async () => (await recipient.service.sync({
    sessionId: recipient.accSessionId, scope: "full" }))
    .snapshot.receipts.find(item => item.messageId === message.messageId)?.state;
  return { place, invoke, message, receipt };
}

test("a turn that ends with an unseen peer message is continued with that message", async t => {
  const { place, invoke, message, receipt } = await withPeerMessage(t);

  const ended = await invoke(event("turnEnd", place.root, { executionNum: 0 }));

  const answer = JSON.parse(ended.stdout);
  assert.equal(answer.decision, "continue");
  assert.match(answer.reason, new RegExp(message.messageId));
  assert.match(answer.reason, /arrived while you were finishing/);
  // Offered only once the bytes are written, exactly as a before-turn offer is.
  assert.equal(await receipt(), "queued");
  await ended.commitOffers();
  assert.equal(await receipt(), "offered");
});

test("a turn with nothing new for this session ends normally", async t => {
  const place = await workspace(t);
  const invoke = harness(place);
  await invoke(event("sessionStart", place.root));

  const ended = await invoke(event("turnEnd", place.root, { executionNum: 0 }));

  // Not even the owner header: continuing a turn to repeat an identity the model
  // already has would spend the operator's quota on nothing.
  assert.equal(ended.stdout, "");
});

test("past the adapter's ceiling the turn ends and the message waits", async t => {
  const { place, invoke, message, receipt } = await withPeerMessage(t);

  const ended = await invoke(event("turnEnd", place.root, { executionNum: 1 }));
  await ended.commitOffers();

  assert.equal(ended.stdout, "");
  assert.equal(await receipt(), "queued",
    "a body nobody was shown must stay queued for the next invocation");
  const next = await invoke(event("beforeTurn", place.root));
  assert.match(next.stdout, new RegExp(message.messageId));
});

test("a client with no way to continue a turn is answered exactly as before", async t => {
  const { place, invoke } = await withPeerMessage(t, { continues: false });

  const ended = await invoke(event("turnEnd", place.root));

  assert.equal(ended.stdout, "");
});

test("an end of turn never starts a session", async t => {
  const place = await workspace(t);
  const invoke = harness(place);

  const ended = await invoke(event("turnEnd", place.root, { executionNum: 0 }));

  assert.equal(ended.stdout, "");
  assert.deepEqual(ended.sessions ?? [], []);
});
