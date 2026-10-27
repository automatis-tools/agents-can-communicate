import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import attention from "../../scripts/measure/probes/attention.mjs";

// #304: a probe proves the useful work from its scenario alone, so a correct
// optimization passes and skipped work fails, whatever the traversal costs.
const repo = path.resolve(import.meta.dirname, "..", "..");
const scenario = attention.scenario({ ownRequests: 40, fanout: 3, acknowledgedShare: 0.5,
  offlineShare: 0.5, inboundObligations: 12, seed: 7 });

test("an attention scenario is deterministic and its hash names its parameters", async () => {
  const side = await attention.load(repo);
  const first = await attention.build(scenario, side), second = await attention.build(scenario, side);
  assert.equal(first.digest, second.digest);
  assert.equal(attention.hash(scenario), attention.hash(attention.scenario({ ...scenario })));
  assert.notEqual(attention.hash(scenario), attention.hash(attention.scenario({ ...scenario, seed: 8 })));
  const kinds = new Set(first.expected.map(item => item.kind));
  for (const kind of ["recipient_unavailable", "reply_required", "acknowledgement_required"]) {
    assert.ok(kinds.has(kind), `the scenario expects some ${kind}`);
  }
});

test("the current attention computation does the useful work", async () => {
  const side = await attention.load(repo);
  const built = await attention.build(scenario, side);
  assert.deepEqual(await attention.validate(built, await attention.operate(built)), []);
});

test("fully acknowledged history stays quiet beside the witnesses every scenario carries", async () => {
  const side = await attention.load(repo);
  const quiet = await attention.build(attention.scenario({ ...scenario, acknowledgedShare: 1 }), side);
  assert.deepEqual(quiet.expected.map(item => item.sourceId).filter(id => !id.includes("witness")), []);
  // Two per witness, six unavailable recipients, four messages left for ended sessions,
  // the decision that replaced another, and three claims.
  assert.equal(quiet.expected.length, 2 * scenario.witnesses + 14);
  assert.deepEqual(await attention.validate(quiet, await attention.operate(quiet)), []);
  for (const [name, mutate] of Object.entries(attention.mutations)) {
    const failures = await attention.validate(quiet, await (await mutate(attention.operate, { side, scenario: quiet.scenario }))(quiet));
    assert.notDeepEqual(failures, [], `${name} passed on quiet history`);
  }
});

test("a session record alone is no presence, and one online session of several is", async () => {
  const side = await attention.load(repo);
  const built = await attention.build(scenario, side);
  const presence = built.expected.filter(item => item.sourceId.includes("presence")).map(item => item.detail).sort();
  assert.deepEqual(presence, ["peer_closed", "peer_dead_pid", "peer_expired", "peer_live_pid_ancient",
    "peer_live_pid_silent", "peer_stale"]);
  // Stale recipients are unavailable but still present: only the offline ones have left. Eight
  // such messages fall in the window; the newest five are chosen, and the one this session was
  // told about is then dropped.
  const left = built.expected.filter(item => item.kind === "left_for_ended_session").map(item => item.sourceId);
  assert.equal(left.length, 4);
  assert.equal(left.some(id => built.snapshot.sessions[0].extensions.noticedLeftMessages.includes(id)), false);
  const kinds = new Set(built.expected.map(item => item.kind));
  for (const kind of ["claim_conflict", "claim_contended", "claim_expired"]) assert.ok(kinds.has(kind), kind);
  assert.deepEqual(built.expected.filter(item => item.sourceId.includes("decision")).map(item => item.sourceId),
    [built.snapshot.messages.find(message => message.decisionChange).messageId]);
  assert.deepEqual(await attention.validate(built, await attention.operate(built)), []);
});

test("witnesses carry the scenario, so another size with the same seed expects other items", async () => {
  const side = await attention.load(repo);
  const one = await attention.build(scenario, side);
  const other = await attention.build(attention.scenario({ ...scenario, ownRequests: scenario.ownRequests + 1 }), side);
  const witnesses = value => value.expected.filter(item => item.sourceId.includes("witness")).map(item => item.sourceId);
  assert.equal(witnesses(one).filter(id => witnesses(other).includes(id)).length, 0);
});

test("a scenario that expects nothing is refused, since a constant answer would pass it", async () => {
  const side = await attention.load(repo);
  const empty = await attention.build(attention.scenario({ ...scenario, acknowledgedShare: 1, witnesses: 0 }), side);
  assert.match((await attention.validate(empty, [])).join(), /expects nothing/);
});

test("each call reads its own copy of the snapshot", async () => {
  const side = await attention.load(repo);
  const built = await attention.build(scenario, side);
  const first = attention.prepare(built), second = attention.prepare(built);
  assert.notEqual(first.snapshot, second.snapshot);
  assert.notEqual(first.context, second.context);
  assert.notEqual(first.context.pidIsAlive, second.context.pidIsAlive);
  assert.notEqual(first.snapshot.receipts, built.snapshot.receipts);
  assert.deepEqual(first.snapshot, built.snapshot);
});

// A correct computation built another way, as #305 may build it: receipts grouped
// by message once, and presence decided once per participant. Each flag breaks one
// rule of the product's, for the test that the witnesses catch it.
async function groupedAttention(broken = {}) {
  const core = name => import(pathToFileURL(path.join(repo, "packages", "core", "src", name)).href);
  const [{ ATTENTION_PRIORITY, LEFT_MESSAGE_WINDOW_MS, LEFT_MESSAGE_LIMIT }, { classifySessionPresence },
    { decisionView, isCurrentDecision }, { overlaps }, { isCurrentIntent }] = await Promise.all([core("attention.mjs"),
    core("sessions.mjs"), core("decision-state.mjs"), core("claims.mjs"), core("intents.mjs")]);
  const RANK = { offline: 0, stale: 1, online: 2 };
  return (snapshot, { session, participantId, now, pidIsAlive }) => {
    const messages = broken.decisions ? snapshot.messages
      : snapshot.messages.map(decisionView(snapshot.messages)).filter(isCurrentDecision);
    const byMessage = new Map();
    for (const receipt of snapshot.receipts) {
      if (!byMessage.has(receipt.messageId)) byMessage.set(receipt.messageId, []);
      byMessage.get(receipt.messageId).push(receipt);
    }
    const best = new Map();
    for (const session of snapshot.sessions) {
      const age = Date.parse(now) - Date.parse(session.heartbeatAt);
      const presence = broken.hardFloor && session.pid !== null && session.state !== "closed" && pidIsAlive(session.pid)
        ? (age <= session.heartbeatCadenceMs * 3 ? "online" : "stale") : classifySessionPresence(session, now, pidIsAlive);
      const rank = RANK[presence];
      best.set(session.participantId, Math.max(rank, best.get(session.participantId) ?? -1));
    }
    const items = [], left = [];
    const item = (kind, sourceId, summary) => items.push({ kind, priority: ATTENTION_PRIORITY[kind], sourceId, summary });
    for (const message of messages) {
      const receipts = byMessage.get(message.messageId) ?? [];
      const kind = { reply: "reply_required", acknowledge: "acknowledgement_required" }[message.obligation];
      for (const receipt of receipts) {
        if (kind && receipt.recipientParticipantId === participantId && receipt.state !== "acknowledged") {
          item(kind, message.messageId, `message ${message.messageId} is a ${message.kind}`);
        }
      }
      if (message.fromParticipantId === participantId && message.toParticipantIds.length > 0
        && (broken.notes || message.obligation !== "none")) {
        for (const receipt of receipts) {
          if (receipt.state !== "acknowledged" && best.get(receipt.recipientParticipantId) !== RANK.online) {
            item("recipient_unavailable", message.messageId, `${message.subject} - ${receipt.recipientParticipantId} is unavailable`);
          }
        }
      }
      if (message.fromParticipantId !== participantId && message.toParticipantIds.length > 0
        && !message.toParticipantIds.includes(participantId)
        && (broken.window || Date.parse(now) - Date.parse(message.sentAt) < LEFT_MESSAGE_WINDOW_MS)
        && receipts.some(receipt => (broken.offered ? ["queued"] : ["queued", "offered"]).includes(receipt.state)
          && (best.get(receipt.recipientParticipantId) ?? RANK.offline) === RANK.offline)) left.push(message);
    }
    left.sort((a, b) => b.sentAt.localeCompare(a.sentAt));
    const noticed = new Set(broken.noticed ? [] : [session, ...snapshot.sessions
      .filter(item => item.participantId === participantId)].flatMap(item => item?.extensions?.noticedLeftMessages ?? []));
    const chosen = broken.noticedFirst ? left.filter(message => !noticed.has(message.messageId)) : left;
    for (const message of broken.limit ? chosen : chosen.slice(0, LEFT_MESSAGE_LIMIT)) {
      if (!noticed.has(message.messageId)) item("left_for_ended_session", message.messageId, "waiting");
    }
    const live = claim => Date.parse(claim.expiresAt) > Date.parse(now);
    const current = snapshot.intents.filter(broken.doneIntents ? () => true : isCurrentIntent);
    const mine = current.find(intent => intent.sessionId === session.sessionId);
    for (const claim of snapshot.claims) {
      const own = claim.ownerSessionId === session.sessionId;
      if (!own && (broken.lapsedClaims || live(claim)) && mine?.resourceHints.some(hint => overlaps(hint, claim.resource))) {
        item("claim_conflict", claim.claimId, "claimed");
      }
      if (own && live(claim) && current.some(intent => intent.sessionId !== session.sessionId
        && intent.resourceHints.some(hint => overlaps(hint, claim.resource)))) item("claim_contended", claim.claimId, "contended");
      if (own && !live(claim)) item("claim_expired", claim.claimId, "expired");
    }
    return items.sort((a, b) => a.priority - b.priority || a.sourceId.localeCompare(b.sourceId));
  };
}

test("a correct computation built another way passes, receipts grouped by message", async () => {
  const side = await attention.load(repo), grouped = await groupedAttention();
  for (const value of [scenario, attention.scenario({ ...scenario, acknowledgedShare: 1 }),
    attention.scenario({ ...scenario, fanout: 1, offlineShare: 0, inboundObligations: 0, leftRule: "window" })]) {
    const built = await attention.build(value, side), input = attention.prepare(built);
    assert.deepEqual(await attention.validate(built, grouped(input.snapshot, input.context)), [], JSON.stringify(value));
  }
});

test("every rule a witness shows catches the computation that breaks it", async () => {
  const side = await attention.load(repo);
  // The week shows only when fewer messages fall in it than the product reports.
  const shown = { limit: ["limit", "noticedFirst"], window: ["window"] };
  const rules = ["decisions", "hardFloor", "notes", "offered", "noticed", "doneIntents", "lapsedClaims"];
  for (const leftRule of ["limit", "window"]) {
    const built = await attention.build(attention.scenario({ ...scenario, leftRule }), side);
    for (const rule of [...rules, ...shown[leftRule]]) {
      const input = attention.prepare(built), wrong = await groupedAttention({ [rule]: true });
      assert.notDeepEqual(await attention.validate(built, wrong(input.snapshot, input.context)), [], `${leftRule}/${rule} passed`);
    }
  }
});

test("a correct computation that walks the records in another order passes", async () => {
  const side = await attention.load(repo);
  const built = await attention.build(scenario, side);
  const reversed = { ...attention.prepare(built), snapshot: { ...built.snapshot,
    messages: [...built.snapshot.messages].reverse(), receipts: [...built.snapshot.receipts].reverse() } };
  assert.deepEqual(await attention.validate(built, await attention.operate(built, reversed)), []);
});

test("every negative mutation fails validation", async () => {
  const side = await attention.load(repo);
  const built = await attention.build(scenario, side);
  assert.ok(Object.keys(attention.mutations).length >= 4);
  for (const [name, mutate] of Object.entries(attention.mutations)) {
    const operate = await mutate(attention.operate, { side, scenario });
    const failures = await attention.validate(built, await operate(built));
    assert.notDeepEqual(failures, [], `${name} passed validation`);
  }
});

test("observations count record visits without deciding validity", async () => {
  const side = await attention.load(repo);
  const built = await attention.build(scenario, side);
  const observed = await attention.observe(built);
  assert.ok(observed.receiptVisits >= built.snapshot.receipts.length, JSON.stringify(observed));
  assert.ok(observed.messageVisits >= built.snapshot.messages.length, JSON.stringify(observed));
  assert.equal(observed.items, built.expected.length);
});
