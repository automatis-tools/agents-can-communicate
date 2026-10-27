// Attention computation (#305). The scenario decides which items are due as it
// creates each receipt, so the validator never asks the implementation.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonical, counted, digest, multisetFailures, pad, random, shuffle } from "../probe-kit.mjs";

const NOW = "2026-10-26T12:00:00.000Z";
const ME = "measured";
const PRIORITY = { reply_required: 1, acknowledgement_required: 2, recipient_unavailable: 3, claim_conflict: 4,
  claim_contended: 5, claim_expired: 6, left_for_ended_session: 7 };
// What the product reports of messages left for ended sessions: the newest five within a week.
const LEFT_LIMIT = 5, LEFT_WINDOW_MS = 7 * 24 * 60 * 60_000;
const PENDING = ["queued", "offered", "retrieved"];

// Witnesses are items every scenario must return, whatever its shares: a
// scenario that expects nothing cannot tell useful work from a constant answer.
// With them come requests to recipients whose sessions the product judges in
// different ways, so a computation that takes any session record for presence,
// or lets one record of several decide, fails.
// `leftRule` picks which rule the messages left for ended sessions show: with "limit", more of
// them fall in the week than the product reports; with "window", fewer do, and one older message
// would join them if the week were ignored. One snapshot cannot show both.
const defaults = { ownRequests: 100, fanout: 2, acknowledgedShare: 0.5, offlineShare: 0.5,
  inboundObligations: 20, witnesses: 4, leftRule: "limit", seed: 1 };

function scenario(input = {}) {
  const value = { probe: "attention", ...defaults, ...input };
  for (const key of ["ownRequests", "fanout", "inboundObligations", "witnesses", "seed"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error(`attention ${key} must be a whole number`);
  }
  for (const key of ["acknowledgedShare", "offlineShare"]) {
    if (!(value[key] >= 0 && value[key] <= 1)) throw new Error(`attention ${key} must lie in 0..1`);
  }
  if (value.fanout < 1) throw new Error("attention fanout must be at least 1");
  if (!["limit", "window"].includes(value.leftRule)) throw new Error("attention leftRule is limit or window");
  return value;
}

const load = async root => import(pathToFileURL(path.join(root, "packages", "core", "src", "attention.mjs")).href);

const session = (participantId, now, fields = {}) => ({ sessionId: `session_${participantId}`, participantId,
  state: "open", heartbeatAt: now, heartbeatCadenceMs: 60_000, pid: null, ...fields });
const ago = minutes => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
const LIVE_PID = 4242, DEAD_PID = 4343;
// Recipient, its sessions, whether a request to it is due as `recipient_unavailable`
// (only an online session makes a recipient available), and whether a message left for
// it by someone else is due as `left_for_ended_session` (only an offline one is gone).
const PRESENCE = [
  ["peer_closed", [{ state: "closed" }], true, true],
  // Silent past three cadences is stale: unavailable, but still present.
  ["peer_stale", [{ heartbeatAt: ago(5) }], true, false],
  // Past the unknown-pid floor is offline.
  ["peer_expired", [{ heartbeatAt: ago(31) }], true, true],
  ["peer_dead_pid", [{ pid: DEAD_PID }], true, true],
  // A live pid past the hard floor is offline: pids are reused.
  ["peer_live_pid_ancient", [{ pid: LIVE_PID, heartbeatAt: ago(25 * 60) }], true, true],
  ["peer_live_pid", [{ pid: LIVE_PID, heartbeatAt: ago(2) }], false, false],
  // A live pid does not make a silent session online.
  ["peer_live_pid_silent", [{ pid: LIVE_PID, heartbeatAt: ago(10) }], true, false],
  // One online session of several makes the recipient available, first or last.
  ["peer_online_then_closed", [{}, { state: "closed" }], false, false],
  ["peer_closed_then_online", [{ state: "closed" }, {}], false, false],
];

// Build the snapshot computeAttention reads, and the items it must return.
async function build(scenario, side) {
  const next = random(scenario.seed), expected = [];
  const pool = Array.from({ length: scenario.fanout * 4 }, (_, index) => `peer_${pad(index, 3)}`);
  const offline = new Set(pool.slice(0, Math.round(pool.length * scenario.offlineShare)));
  const online = pool.filter(id => !offline.has(id));
  const absent = "peer_absent";
  const sessions = [session(ME, NOW), ...online.map(id => session(id, NOW))];
  const messages = [], receipts = [];
  const sentAt = index => new Date(Date.parse(NOW) - 60_000 + index).toISOString();
  for (let index = 0; index < scenario.ownRequests; index++) {
    const messageId = `message_out_${pad(index)}`;
    const to = shuffle(pool, next).slice(0, scenario.fanout).sort();
    messages.push({ messageId, kind: "request", obligation: "reply", fromParticipantId: ME,
      toParticipantIds: to, subject: `request ${index}`, sentAt: sentAt(index) });
    for (const recipient of to) {
      const state = next() < scenario.acknowledgedShare ? "acknowledged" : PENDING[Math.floor(next() * 3)];
      receipts.push({ messageId, recipientParticipantId: recipient, state });
      if (state !== "acknowledged" && offline.has(recipient)) {
        expected.push({ kind: "recipient_unavailable", sourceId: messageId, detail: recipient });
      }
    }
  }
  for (let index = 0; index < scenario.inboundObligations; index++) {
    const messageId = `message_in_${pad(index)}`;
    const obligation = index % 2 === 0 ? "reply" : "acknowledge";
    const from = online.length ? online[Math.floor(next() * online.length)] : pool[0];
    messages.push({ messageId, kind: obligation === "reply" ? "question" : "decision", obligation,
      fromParticipantId: from, toParticipantIds: [ME], subject: `inbound ${index}`,
      sentAt: sentAt(scenario.ownRequests + index) });
    const state = next() < scenario.acknowledgedShare ? "acknowledged" : PENDING[Math.floor(next() * 3)];
    receipts.push({ messageId, recipientParticipantId: ME, state });
    if (state !== "acknowledged") {
      expected.push({ kind: obligation === "reply" ? "reply_required" : "acknowledgement_required",
        sourceId: messageId, detail: null });
    }
  }
  // Named by the whole scenario, so an answer computed for another fixture never matches.
  const tag = digest(scenario).slice(0, 12);
  const claims = [], intents = [];
  if (scenario.witnesses > 0) {
    const left = [];
    const leave = (recipient, messageId, at, state, gone) => {
      messages.push({ messageId, kind: "note", obligation: "none", fromParticipantId: "peer_sender",
        toParticipantIds: [recipient], subject: `left for ${recipient}`, sentAt: at });
      receipts.push({ messageId, recipientParticipantId: recipient, state });
      if (gone && Date.parse(NOW) - Date.parse(at) < LEFT_WINDOW_MS) left.push({ messageId, sentAt: at });
    };
    for (const [index, [recipient, records, due, gone]] of PRESENCE.entries()) {
      for (const [number, fields] of records.entries()) {
        sessions.push({ ...session(recipient, NOW, fields), sessionId: `session_${recipient}_${number}` });
      }
      const messageId = `message_witness_presence_${tag}_${pad(index)}`;
      messages.push({ messageId, kind: "request", obligation: "reply", fromParticipantId: ME,
        toParticipantIds: [recipient], subject: `presence ${recipient}`, sentAt: sentAt(-100 - index) });
      receipts.push({ messageId, recipientParticipantId: recipient, state: "offered" });
      if (due) expected.push({ kind: "recipient_unavailable", sourceId: messageId, detail: recipient });
      // Left for it by another participant, queued or offered, and once more earlier for an
      // offline one, so more qualify than the product reports.
      leave(recipient, `message_witness_left_${tag}_${pad(index)}`, sentAt(-200 - index), index % 2 ? "offered" : "queued", gone);
      if (gone && scenario.leftRule === "limit") {
        leave(recipient, `message_witness_left_again_${tag}_${pad(index)}`, sentAt(-400 - index), "queued", gone);
      }
    }
    // Left more than a week ago: past the window.
    leave("peer_closed", `message_witness_left_old_${tag}`, ago(8 * 24 * 60), "queued", true);
    // The newest five are chosen before the ones this session was told about are dropped.
    left.sort((a, b) => b.sentAt.localeCompare(a.sentAt));
    const noticed = left[0].messageId;
    sessions[0].extensions = { noticedLeftMessages: [noticed] };
    for (const { messageId } of left.slice(0, LEFT_LIMIT)) {
      if (messageId !== noticed) expected.push({ kind: "left_for_ended_session", sourceId: messageId, detail: null });
    }
    // A note asks nothing of its recipient, so its absence is no attention item.
    messages.push({ messageId: `message_witness_note_${tag}`, kind: "note", obligation: "none", fromParticipantId: ME,
      toParticipantIds: [absent], subject: "a note", sentAt: sentAt(-500) });
    receipts.push({ messageId: `message_witness_note_${tag}`, recipientParticipantId: absent, state: "queued" });
    // A replaced decision leaves attention; the decision that replaced it is due.
    const replaced = `message_witness_decision_old_${tag}`, current = `message_witness_decision_new_${tag}`;
    messages.push({ messageId: replaced, kind: "decision", obligation: "acknowledge", fromParticipantId: "peer_live_pid",
      toParticipantIds: [ME], subject: "first decision", sentAt: sentAt(-600) },
    { messageId: current, kind: "decision", obligation: "acknowledge", fromParticipantId: "peer_live_pid",
      toParticipantIds: [ME], subject: "second decision", sentAt: sentAt(-599),
      decisionChange: { action: "replace", messageIds: [replaced] } });
    receipts.push({ messageId: replaced, recipientParticipantId: ME, state: "offered" },
      { messageId: current, recipientParticipantId: ME, state: "offered" });
    expected.push({ kind: "acknowledgement_required", sourceId: current, detail: null });
    // Claims: a peer's live claim on what this session means to touch conflicts, an expired one
    // does not; this session's live claim on what a peer means to touch is contended, a done
    // peer intent contends nothing; this session's expired claim has run out.
    const mine = sessions[0].sessionId, peer = "session_peer_online_then_closed_0";
    const later = new Date(Date.parse(NOW) + 3_600_000).toISOString(), earlier = ago(1);
    intents.push({ sessionId: mine, participantId: ME, state: "active", resourceHints: ["file:src/**"] },
      { sessionId: peer, participantId: "peer_online_then_closed", state: "active", resourceHints: ["file:docs/guide.md"] },
      { sessionId: "session_peer_live_pid_0", participantId: "peer_live_pid", state: "done", resourceHints: ["file:notes/a.md"] });
    const claim = (name, ownerSessionId, resource, expiresAt, kind) => {
      claims.push({ claimId: `claim_witness_${name}_${tag}`, ownerSessionId, resource, expiresAt });
      if (kind) expected.push({ kind, sourceId: `claim_witness_${name}_${tag}`, detail: null });
    };
    claim("conflict", peer, "file:src/core.mjs", later, "claim_conflict");
    claim("lapsed", peer, "file:src/old.mjs", earlier, null);
    claim("contended", mine, "file:docs/**", later, "claim_contended");
    claim("expired", mine, "file:tmp/**", earlier, "claim_expired");
    // Only the done intent touches this one.
    claim("finished", mine, "file:notes/**", later, null);
  }
  for (let index = 0; index < scenario.witnesses; index++) {
    const outbound = `message_witness_out_${tag}_${pad(index)}`;
    const inbound = `message_witness_in_${tag}_${pad(index)}`;
    messages.push({ messageId: outbound, kind: "request", obligation: "reply", fromParticipantId: ME,
      toParticipantIds: [absent], subject: `witness ${index}`, sentAt: sentAt(-1 - index) });
    receipts.push({ messageId: outbound, recipientParticipantId: absent, state: "queued" });
    expected.push({ kind: "recipient_unavailable", sourceId: outbound, detail: absent });
    const obligation = index % 2 === 0 ? "reply" : "acknowledge";
    messages.push({ messageId: inbound, kind: obligation === "reply" ? "question" : "decision", obligation,
      fromParticipantId: online[0] ?? absent, toParticipantIds: [ME], subject: `witness in ${index}`,
      sentAt: sentAt(-1 - index) });
    receipts.push({ messageId: inbound, recipientParticipantId: ME, state: "offered" });
    expected.push({ kind: obligation === "reply" ? "reply_required" : "acknowledgement_required",
      sourceId: inbound, detail: null });
  }
  const snapshot = { sessions, messages, receipts, claims, intents };
  return { scenario, side, snapshot, expected, digest: digest(snapshot) };
}

// Each call gets its own copy of the snapshot and of its context, made outside the
// timed call, as each hook process reads its own: a result kept for the same objects
// proves nothing.
const prepare = built => {
  const snapshot = structuredClone(built.snapshot);
  return { snapshot, context: { session: snapshot.sessions[0], participantId: ME, now: NOW,
    pidIsAlive: pid => pid !== DEAD_PID } };
};
const operate = async (built, input = prepare(built)) => built.side.computeAttention(input.snapshot, input.context);

const keyOf = item => canonical(item);
function normalise(item) {
  if (item === null || typeof item !== "object") return { kind: "?", sourceId: null, detail: null };
  const detail = item.kind === "recipient_unavailable"
    ? / - (\S+) is unavailable$/.exec(item.summary ?? "")?.[1] ?? "?" : null;
  return { kind: item.kind, sourceId: item.sourceId, detail };
}

function validate(built, result) {
  if (built.expected.length === 0) return ["attention: the scenario expects nothing, so it cannot prove work"];
  if (!Array.isArray(result)) return ["attention: result is not a list"];
  const failures = [];
  for (const item of result.map(value => value ?? {})) {
    if (PRIORITY[item.kind] === undefined) failures.push(`attention: unexpected kind ${item.kind}`);
    else if (item.priority !== PRIORITY[item.kind]) failures.push(`attention: ${item.kind} has priority ${item.priority}`);
  }
  for (let index = 1; index < result.length; index++) {
    const before = result[index - 1] ?? {}, after = result[index] ?? {};
    if (before.priority > after.priority
      || (before.priority === after.priority && String(before.sourceId).localeCompare(String(after.sourceId)) > 0)) {
      failures.push(`attention: items ${index - 1} and ${index} are out of order`);
      break;
    }
  }
  return [...failures, ...multisetFailures(built.expected.map(keyOf), result.map(normalise).map(keyOf), "attention")];
}

// What one call touched, counted in a separate untimed call of the code the child measures.
async function observe(built, run = operate) {
  const counter = {}, input = prepare(built), copy = input.snapshot;
  const snapshot = { ...copy, messages: counted(copy.messages, counter, "messageVisits"),
    receipts: counted(copy.receipts, counter, "receiptVisits"), sessions: counted(copy.sessions, counter, "sessionVisits") };
  const result = await run(built, { ...input, snapshot });
  return { failures: validate(built, result), ...counter, items: result.length, messages: copy.messages.length,
    receipts: copy.receipts.length };
}

// Each wraps a correct computation and breaks it in one way validation must catch.
const mutations = {
  "drop-one": async operate => async (built, input) => (await operate(built, input)).slice(0, -1),
  "constant-empty": async () => async () => [],
  "skip-unavailable": async operate => async (built, input) =>
    (await operate(built, input)).filter(item => item.kind !== "recipient_unavailable"),
  "duplicate-first": async operate => async (built, input) => { const result = await operate(built, input); return [result[0], ...result]; },
  "stale-fixture": async (operate, { side, scenario }) => {
    const stale = await operate(await build({ ...scenario, seed: scenario.seed + 1 }, side));
    return async () => stale;
  },
  "reversed-order": async operate => async (built, input) => (await operate(built, input)).reverse(),
  // Takes any session record for presence, whatever its state, heartbeat or pid.
  "presence-ignored": async operate => async (built, input = prepare(built)) => operate(built,
    { ...input, snapshot: { ...input.snapshot, sessions: input.snapshot.sessions.map(item => ({ ...item, state: "open",
      heartbeatAt: NOW, pid: null })) } }),
  // Lets the last session record of each participant decide its presence.
  "last-session-decides": async operate => async (built, input = prepare(built)) => operate(built,
    { ...input, snapshot: { ...input.snapshot, sessions: [...new Map(input.snapshot.sessions
      .map(item => [item.participantId, item])).values()] } }),
  // Takes a live pid for online at any age.
  "live-pid-any-age": async operate => async (built, input = prepare(built)) => operate(built,
    { ...input, snapshot: { ...input.snapshot, sessions: input.snapshot.sessions.map(item => item.pid === LIVE_PID
      ? { ...item, heartbeatAt: NOW } : item) } }),
  // The answer for a fixture with the same seed and one more request.
  "other-size": async (operate, { side, scenario }) => {
    const other = await operate(await build({ ...scenario, ownRequests: scenario.ownRequests + 1 }, side));
    return async () => other;
  },
};

export default { name: "attention", scenario, hash: value => digest(scenario(value)), load, build, prepare,
  operate, validate, observe, mutations, mutationsFor: () => mutations, capacity: () => Infinity, dispose: async () => {} };
