// Transactions against a growing event history (#307). Messages stay constant
// while ordinary writes add events. Every call opens its own store, and the
// validator reads the published log back through another: a read commits
// nothing, and a write commits one event with the next sequence.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { digest } from "../probe-kit.mjs";
import { eventsAfter, loadStoreSide, openInstance, openStoreFixture, primaryDigest, receiptStates }
  from "../store-fixture.mjs";

// `pendingJournal` leaves one decided write unpublished, as a crash after its
// journal would: every read of that message must still see the decision.
const defaults = { messages: 30, events: 100, operation: "read", pendingJournal: false, seed: 1 };
// What the product publishes for a successful offer.
const OFFER_EVENT = "message.offer_succeeded";

function scenario(input = {}) {
  const value = { probe: "transaction", ...defaults, ...input };
  for (const key of ["messages", "events", "seed"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error(`transaction ${key} must be a whole number`);
  }
  if (!["read", "write"].includes(value.operation)) throw new Error("transaction operation is read or write");
  if (typeof value.pendingJournal !== "boolean") throw new Error("transaction pendingJournal is true or false");
  if (value.pendingJournal && value.operation !== "read") throw new Error("a pending journal is measured by reads");
  if (value.messages < (value.pendingJournal ? 2 : 1)) throw new Error("transaction needs messages");
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
  const states = new Map(messages.map(message => [message.messageId, "queued"]));
  const built = { scenario, side, fixture, messages, offer, next: 0, target: null, states, pending: null,
    events: await eventCount(fixture.root), digest: await primaryDigest(fixture, side) };
  built.eventCursor = (await eventsAfter(fixture, side, null)).cursor;
  if (scenario.pendingJournal) {
    // The first message, so the first read is the one that has to see the decision.
    const last = messages[0], crash = async point => { if (point === "after-journal") throw new Error("probe crash"); };
    const { service } = await openInstance(fixture, side, { failAt: crash });
    await service.recordOfferSucceeded(offer(last)).then(() => { throw new Error("the write did not stop at its journal"); },
      error => { if (error.message !== "probe crash") throw error; });
    states.set(last.messageId, "offered");
    built.pending = { messageId: last.messageId, published: false };
  }
  built.receipts = await receiptStates(fixture, side);
  return built;
}

const capacity = value => value.operation === "write" ? value.messages : Infinity;
const prepare = async built => openInstance(built.fixture, built.side);

async function operate(built, input) {
  if (built.scenario.operation === "read") {
    const message = built.messages[built.next++ % built.messages.length];
    built.target = message.messageId;
    return input.service.readReceipt(built.offer(message));
  }
  // Each write offers a message not offered before, so each commits a transition.
  const message = built.messages[built.next++];
  if (message === undefined) throw new Error("the transaction scenario has fewer messages than writes");
  built.target = message.messageId;
  return input.service.recordOfferSucceeded(built.offer(message));
}

async function validate(built, result) {
  const failures = [], { fixture, side } = built, write = built.scenario.operation === "write";
  const expected = write ? "offered" : built.states.get(built.target);
  if (result?.messageId !== built.target || result?.state !== expected) {
    failures.push(`transaction: returned ${result?.messageId} ${result?.state}, not ${built.target} ${expected}`);
  }
  const { events, cursor } = await eventsAfter(fixture, side, built.eventCursor);
  // Finishing the decided write publishes its event once; that is no commit of the read's.
  const own = events.filter(event => {
    const finished = built.pending && !built.pending.published && event.type === OFFER_EVENT
      && event.payload?.messageId === built.pending.messageId;
    if (finished) built.pending.published = true;
    return !finished;
  });
  if (!write && own.length !== 0) failures.push(`transaction: a read committed ${own.length} event(s)`);
  if (write && own.length !== 1) failures.push(`transaction: a write committed ${own.length} events, not one`);
  if (write && own.length === 1) {
    const [event] = own;
    const next = String(BigInt(built.eventCursor ?? "0") + 1n).padStart(String(event.sequence).length, "0");
    if (event.sequence !== next) failures.push(`transaction: event ${event.sequence} does not follow ${built.eventCursor}`);
    if (event.type !== OFFER_EVENT || event.payload?.messageId !== built.target) {
      failures.push(`transaction: the event is ${event.type} for ${event.payload?.messageId}`);
    }
  }
  const now = await receiptStates(fixture, side), moved = side.receiptId(built.target, "reader");
  for (const [id, before] of built.receipts) {
    const after = now.get(id);
    if (id === moved && write) {
      if (after?.state !== "offered") failures.push(`transaction: ${before.messageId} is ${after?.state}, not offered`);
    } else if (after?.state !== before.state || after?.generation !== before.generation) {
      failures.push(`transaction: an unrelated receipt for ${before.messageId} changed`);
    }
  }
  if (write) built.states.set(built.target, "offered");
  built.receipts = now;
  built.eventCursor = cursor;
  return failures;
}

async function observe(built) {
  const helper = path.resolve(import.meta.dirname, "..", "..", "..", "tests", "helpers", "store-io-probe.mjs");
  const { createStoreIoProbe } = await import(pathToFileURL(helper).href);
  const input = await prepare(built), probe = createStoreIoProbe(built.fixture.root);
  let measured;
  try { measured = await probe.capture(() => operate(built, input)); } finally { probe.stop(); }
  const enumerations = Object.fromEntries(Object.entries(measured.io).filter(([key]) => /\/readdir(Entries)?$/.test(key)));
  return { failures: await validate(built, measured.result), events: built.events, stateReads: measured.stateReads,
    stateByKind: measured.stateByKind, readBytes: measured.readBytes, enumerations };
}

const intentWrite = (built, input) => input.service.setIntent({ ...built.fixture.owner("reader"),
  summary: "an extra write", mode: "edit" });
const readMutations = {
  "commits-on-read": async operate => async (built, input) => {
    const result = await operate(built, input);
    await intentWrite(built, input);
    return result;
  },
  "wrong-receipt": async operate => async (built, input) => {
    const result = await operate(built, input);
    return { ...result, messageId: built.messages[built.next % built.messages.length].messageId };
  },
  // Offers a message that is still queued, where a read must change nothing.
  "advances-on-read": async () => async (built, input) => {
    const message = built.messages.find(item => built.states.get(item.messageId) === "queued");
    built.target = message.messageId;
    return input.service.recordOfferSucceeded(built.offer(message));
  },
  // Answers from the receipts as first built, missing what was decided since.
  "stale-state": async operate => async (built, input) => ({ ...await operate(built, input),
    state: built.pending ? "queued" : "offered" }),
};
const writeMutations = {
  // Reports a transition that was never committed.
  "skip-commit": async () => async built => {
    const message = built.messages[built.next++];
    built.target = message.messageId;
    return { messageId: message.messageId, recipientParticipantId: "reader", state: "offered" };
  },
  "two-commits": async operate => async (built, input) => {
    const result = await operate(built, input);
    await intentWrite(built, input);
    return result;
  },
  "wrong-target": async () => async (built, input) => {
    const intended = built.messages[built.next], other = built.messages[built.next + 1];
    built.next += 2;
    built.target = intended.messageId;
    return input.service.recordOfferSucceeded(built.offer(other));
  },
};

export default { name: "transaction", scenario, hash: value => digest(scenario(value)), load: loadStoreSide, build,
  capacity, prepare, operate, validate, observe,
  mutationsFor: value => value.operation === "read" ? readMutations : writeMutations,
  dispose: built => built.fixture.dispose() };
