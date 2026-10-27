// Attention computation (#305). The scenario decides which items are due as it
// creates each receipt, so the validator never asks the implementation.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonical, counted, digest, multisetFailures, pad, random, shuffle } from "../probe-kit.mjs";

const NOW = "2026-10-26T12:00:00.000Z";
const ME = "measured";
const PRIORITY = { reply_required: 1, acknowledgement_required: 2, recipient_unavailable: 3 };
const PENDING = ["queued", "offered", "retrieved"];

// Witnesses are items every scenario must return, whatever its shares: a
// scenario that expects nothing cannot tell useful work from a constant answer.
// With them come requests to one recipient in each presence the product tells
// apart, so a computation that takes any session record for presence fails.
const defaults = { ownRequests: 100, fanout: 2, acknowledgedShare: 0.5, offlineShare: 0.5,
  inboundObligations: 20, witnesses: 4, seed: 1 };

function scenario(input = {}) {
  const value = { probe: "attention", ...defaults, ...input };
  for (const key of ["ownRequests", "fanout", "inboundObligations", "witnesses", "seed"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error(`attention ${key} must be a whole number`);
  }
  for (const key of ["acknowledgedShare", "offlineShare"]) {
    if (!(value[key] >= 0 && value[key] <= 1)) throw new Error(`attention ${key} must lie in 0..1`);
  }
  if (value.fanout < 1) throw new Error("attention fanout must be at least 1");
  return value;
}

const load = async root => import(pathToFileURL(path.join(root, "packages", "core", "src", "attention.mjs")).href);

const session = (participantId, now, fields = {}) => ({ sessionId: `session_${participantId}`, participantId,
  state: "open", heartbeatAt: now, heartbeatCadenceMs: 60_000, pid: null, ...fields });
const ago = minutes => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
const LIVE_PID = 4242, DEAD_PID = 4343;
// Recipient, session and whether a request to it is due: closed, silent past three
// cadences, past the unknown-pid floor, and a dead pid are unavailable; a live pid is not.
const PRESENCE = [
  ["peer_closed", { state: "closed" }, true],
  ["peer_stale", { heartbeatAt: ago(5) }, true],
  ["peer_expired", { heartbeatAt: ago(31) }, true],
  ["peer_dead_pid", { pid: DEAD_PID }, true],
  ["peer_live_pid", { pid: LIVE_PID, heartbeatAt: ago(2) }, false],
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
  if (scenario.witnesses > 0) {
    for (const [index, [recipient, fields, due]] of PRESENCE.entries()) {
      sessions.push(session(recipient, NOW, fields));
      const messageId = `message_witness_presence_${tag}_${pad(index)}`;
      messages.push({ messageId, kind: "request", obligation: "reply", fromParticipantId: ME,
        toParticipantIds: [recipient], subject: `presence ${recipient}`, sentAt: sentAt(-100 - index) });
      receipts.push({ messageId, recipientParticipantId: recipient, state: "offered" });
      if (due) expected.push({ kind: "recipient_unavailable", sourceId: messageId, detail: recipient });
    }
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
  const snapshot = { sessions, messages, receipts, claims: [], intents: [] };
  return { scenario, side, snapshot, expected, digest: digest(snapshot),
    context: { session: sessions[0], participantId: ME, now: NOW, pidIsAlive: pid => pid !== DEAD_PID } };
}

// Each call gets its own copy, made outside the timed call, as each hook process
// reads its own snapshot: a result kept for the same object proves nothing.
const prepare = built => ({ snapshot: structuredClone(built.snapshot) });
const operate = async (built, input = prepare(built)) => built.side.computeAttention(input.snapshot, built.context);

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

// What one call touched, counted in a separate untimed call.
async function observe(built) {
  const counter = {}, { snapshot: copy } = prepare(built);
  const snapshot = { ...copy, messages: counted(copy.messages, counter, "messageVisits"),
    receipts: counted(copy.receipts, counter, "receiptVisits"), sessions: counted(copy.sessions, counter, "sessionVisits") };
  const result = await built.side.computeAttention(snapshot, built.context);
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
    { snapshot: { ...input.snapshot, sessions: input.snapshot.sessions.map(item => ({ ...item, state: "open",
      heartbeatAt: NOW, pid: null })) } }),
  // The answer for a fixture with the same seed and one more request.
  "other-size": async (operate, { side, scenario }) => {
    const other = await operate(await build({ ...scenario, ownRequests: scenario.ownRequests + 1 }, side));
    return async () => other;
  },
};

export default { name: "attention", scenario, hash: value => digest(scenario(value)), load, build, prepare,
  operate, validate, observe, mutations, mutationsFor: () => mutations, capacity: () => Infinity, dispose: async () => {} };
