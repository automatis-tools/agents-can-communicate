// Transactions against a growing event history (#307). Messages stay constant
// while ordinary writes add events. The validator reads the published log: a
// read commits nothing, and a write commits one event with the next sequence.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { digest } from "../probe-kit.mjs";
import { loadStoreSide, openStoreFixture, primaryDigest, receiptStates, WORKSPACE } from "../store-fixture.mjs";

const defaults = { messages: 30, events: 100, operation: "read", seed: 1 };

function scenario(input = {}) {
  const value = { probe: "transaction", ...defaults, ...input };
  for (const key of ["messages", "events", "seed"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error(`transaction ${key} must be a whole number`);
  }
  if (!["read", "write"].includes(value.operation)) throw new Error("transaction operation is read or write");
  if (value.messages < 1) throw new Error("transaction needs messages");
  return value;
}

const eventCount = async root => (await readdir(path.join(root, "events")).catch(() => []))
  .filter(name => name.endsWith(".json")).length;

async function build(scenario, side) {
  const fixture = await openStoreFixture(side, ["sender", "reader"], "transaction");
  const messages = [];
  for (let index = 0; index < scenario.messages; index++) {
    fixture.clock.advance(1_000);
    messages.push(await fixture.service.sendMessage({ ...fixture.owner("sender"), clientMessageId: `client_${index}`,
      toParticipantIds: ["reader"], kind: "note", obligation: "none", subject: `message ${index}`,
      body: "Same measured fixture" }));
  }
  // History that grows without touching a message or a receipt.
  for (let round = 0; await eventCount(fixture.root) < scenario.events; round++) {
    fixture.clock.advance(1_000);
    await fixture.service.setIntent({ ...fixture.owner("sender"), summary: `history ${round}`, mode: "edit" });
  }
  const offer = message => ({ messageId: message.messageId, recipientParticipantId: "reader",
    targetSessionId: fixture.sessions.reader.sessionId, targetGeneration: fixture.sessions.reader.generation,
    transport: "next-turn", adapterId: "probe", clientVersion: "1.0.0" });
  return { scenario, side, fixture, messages, offer, cursor: 0, target: null,
    events: await eventCount(fixture.root), digest: await primaryDigest(fixture),
    before: await lastSequence(fixture), receipts: await receiptStates(fixture, side) };
}

async function lastSequence(fixture) {
  let cursor = null;
  for (;;) {
    const page = await fixture.store.eventsSince(WORKSPACE, cursor, 500);
    if (page.events.length === 0) return cursor;
    cursor = page.cursor;
  }
}

async function operate(built) {
  const { fixture, scenario } = built;
  if (scenario.operation === "read") {
    const message = built.messages[built.cursor++ % built.messages.length];
    built.target = message.messageId;
    return fixture.service.readReceipt(built.offer(message));
  }
  // Each write offers a message not offered before, so each commits a transition.
  const message = built.messages[built.cursor++];
  if (message === undefined) throw new Error("the transaction scenario has fewer messages than writes");
  built.target = message.messageId;
  return fixture.service.recordOfferSucceeded(built.offer(message));
}

async function validate(built, result) {
  const failures = [], { fixture, side } = built;
  const expectedState = built.scenario.operation === "read" ? "queued" : "offered";
  if (result?.messageId !== built.target || result?.state !== expectedState) {
    failures.push(`transaction: returned ${result?.messageId} ${result?.state}, not ${built.target} ${expectedState}`);
  }
  const page = await fixture.store.eventsSince(WORKSPACE, built.before, 500);
  if (built.scenario.operation === "read") {
    if (page.events.length !== 0) failures.push(`transaction: a read committed ${page.events.length} event(s)`);
  } else if (page.events.length !== 1) {
    failures.push(`transaction: a write committed ${page.events.length} events, not one`);
  } else {
    const [event] = page.events;
    const next = String(BigInt(built.before ?? "0") + 1n).padStart(String(event.sequence).length, "0");
    if (event.sequence !== next) failures.push(`transaction: event ${event.sequence} does not follow ${built.before}`);
    if (event.payload?.messageId !== built.target) failures.push("transaction: the event names another message");
  }
  const now = await receiptStates(fixture, side), moved = side.receiptId(built.target, "reader");
  for (const [id, before] of built.receipts) {
    const after = now.get(id);
    const changed = after?.state !== before.state || after?.generation !== before.generation;
    if (id === moved && built.scenario.operation === "write") {
      if (after?.state !== "offered") failures.push(`transaction: ${before.messageId} is ${after?.state}, not offered`);
    } else if (changed) failures.push(`transaction: an unrelated receipt for ${before.messageId} changed`);
  }
  built.receipts = now;
  built.before = page.cursor;
  return failures;
}

async function observe(built) {
  const helper = path.resolve(import.meta.dirname, "..", "..", "..", "tests", "helpers", "store-io-probe.mjs");
  const { createStoreIoProbe } = await import(pathToFileURL(helper).href);
  const probe = createStoreIoProbe(built.fixture.root);
  try {
    const measured = await probe.capture(() => operate(built));
    const enumerations = Object.fromEntries(Object.entries(measured.io).filter(([key]) => /\/readdir(Entries)?$/.test(key)));
    return { failures: await validate(built, measured.result), events: built.events, stateReads: measured.stateReads,
      stateByKind: measured.stateByKind, readBytes: measured.readBytes, enumerations };
  } finally { probe.stop(); }
}

const intentWrite = built => built.fixture.service.setIntent({ ...built.fixture.owner("reader"),
  summary: "an extra write", mode: "edit" });
const readMutations = {
  "commits-on-read": async operate => async built => { const result = await operate(built); await intentWrite(built); return result; },
  "wrong-receipt": async operate => async built => {
    const result = await operate(built);
    return { ...result, messageId: built.messages[built.cursor % built.messages.length].messageId };
  },
  "advances-on-read": async () => async built => {
    const message = built.messages[built.cursor++ % built.messages.length];
    built.target = message.messageId;
    return built.fixture.service.recordOfferSucceeded(built.offer(message));
  },
};
const writeMutations = {
  // Reports a transition that was never committed.
  "skip-commit": async () => async built => {
    const message = built.messages[built.cursor++];
    built.target = message.messageId;
    return { messageId: message.messageId, recipientParticipantId: "reader", state: "offered" };
  },
  "two-commits": async operate => async built => { const result = await operate(built); await intentWrite(built); return result; },
  "wrong-target": async () => async built => {
    const intended = built.messages[built.cursor], other = built.messages[built.cursor + 1];
    built.cursor += 2;
    built.target = intended.messageId;
    return built.fixture.service.recordOfferSucceeded(built.offer(other));
  },
};

export default { name: "transaction", scenario, hash: value => digest(scenario(value)), load: loadStoreSide, build,
  operate, validate, observe, mutationsFor: value => value.operation === "read" ? readMutations : writeMutations,
  dispose: built => built.fixture.dispose() };
