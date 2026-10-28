// Transactions against a growing event history (#307). Messages stay constant
// while ordinary writes add events. Every call opens its own store, and the
// validator reads the published log back through another: a read commits
// nothing, and a write commits one event with the next sequence.
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { digest } from "../probe-kit.mjs";
import { eventsAfter, loadStoreSide, openInstance, openStoreFixture, primaryDigest, receiptStates, stateDigest,
  visibleEvents, WORKSPACE } from "../store-fixture.mjs";

// `pendingJournal` stops each read's step behind its journal, as a crash would.
const defaults = { messages: 30, events: 100, operation: "read", pendingJournal: false, seed: 1 };
// What the product publishes for a successful offer.
const OFFER_EVENT = "message.offer_succeeded";
// Every kind a measured call must leave as it was: it may move one receipt and append events.
const OTHER_KINDS = ["workspace", "participant", "session", "intent", "claim", "message"];

function scenario(input = {}) {
  const value = { probe: "transaction", ...defaults, ...input };
  for (const key of ["messages", "events", "seed"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error(`transaction ${key} must be a whole number`);
  }
  if (!["read", "write"].includes(value.operation)) throw new Error("transaction operation is read or write");
  if (typeof value.pendingJournal !== "boolean") throw new Error("transaction pendingJournal is true or false");
  if (value.pendingJournal && value.operation !== "read") throw new Error("a pending journal is measured by reads");
  if (value.messages < 1) throw new Error("transaction needs messages");
  return value;
}

const offer = (fixture, messageId) => ({ messageId, recipientParticipantId: "reader",
  targetSessionId: fixture.sessions.reader.sessionId, targetGeneration: fixture.sessions.reader.generation,
  transport: "next-turn", adapterId: "probe", clientVersion: "1.0.0" });
// The one transition each state allows the reader, through the product's own operations.
const STEPS = {
  queued: { next: "offered", event: OFFER_EVENT,
    run: (service, fixture, messageId) => service.recordOfferSucceeded(offer(fixture, messageId)) },
  offered: { next: "retrieved", event: "message.retrieved",
    run: (service, fixture, messageId) => service.readInbox({ ...fixture.owner("reader"), messageId }) },
  retrieved: { next: "acknowledged", event: "message.acknowledged",
    run: (service, fixture, messageId) => service.acknowledgeMessage({ ...fixture.owner("reader"), messageId }) },
};

// Events counted through the store's own log, never its file layout.
async function countEvents(store, counter) {
  for (;;) {
    const page = await store.eventsSince(WORKSPACE, counter.cursor, 500);
    if (page.events.length === 0) return counter.count;
    counter.count += page.events.length;
    counter.cursor = page.cursor;
  }
}

async function build(scenario, side) {
  const fixture = await openStoreFixture(side, ["sender", "reader"], "transaction");
  const messages = [];
  for (let index = 0; index < scenario.messages; index++) {
    fixture.clock.advance(1_000);
    messages.push(await fixture.service.sendMessage({ ...fixture.owner("sender"), clientMessageId: `client_${index}`,
      toParticipantIds: ["reader"], kind: "note", obligation: "none", subject: `message ${index}`,
      body: "Same measured fixture" }));
  }
  // A read meets receipts in every state it can step from, so no single answer fits.
  // A write offers each message once, so its receipts all start queued.
  const cycle = scenario.operation === "write" ? ["queued"]
    : scenario.pendingJournal ? ["queued", "offered", "retrieved"] : ["queued", "offered", "retrieved", "acknowledged"];
  const states = new Map();
  for (const [index, message] of messages.entries()) {
    const wanted = cycle[index % cycle.length];
    for (let state = "queued"; state !== wanted; state = STEPS[state].next) {
      fixture.clock.advance(1_000);
      await STEPS[state].run(fixture.service, fixture, message.messageId);
    }
    states.set(message.messageId, wanted);
  }
  // History that grows without touching a message or a receipt.
  const counter = { cursor: null, count: 0 };
  for (let round = 0; await countEvents(fixture.store, counter) < scenario.events; round++) {
    fixture.clock.advance(1_000);
    await fixture.service.setIntent({ ...fixture.owner("sender"), summary: `history ${round}`, mode: "edit" });
  }
  const built = { scenario, side, fixture, messages, next: 0, target: null, states, initial: new Map(states),
    pending: null, moved: null, events: counter.count, digest: await primaryDigest(fixture, side),
    others: await stateDigest(fixture, side, OTHER_KINDS) };
  built.eventCursor = (await eventsAfter(fixture, side, null)).cursor;
  built.receipts = await receiptStates(fixture, side);
  return built;
}

// Every read targets a message not read before, and every write one not offered before.
const capacity = value => value.messages;

// Before each read, another process steps the target's receipt, so an answer kept
// from before that step is wrong. With a pending journal the step stops after its
// journal, and the measured store was opened before it: its read must see the
// decision. Finishing the step is the product's way; leaving it to the next store
// that opens is a read-only one, and both are correct.
async function prepare(built) {
  const input = await prepareCall(built);
  // Every record written from here on is the measured call's.
  built.generations = built.fixture.ids.count("generation");
  return input;
}

async function prepareCall(built) {
  const { fixture, side, scenario } = built;
  if (scenario.operation === "write") return openInstance(fixture, side);
  const message = built.messages[built.next];
  if (message === undefined) throw new Error("the transaction scenario has fewer messages than reads");
  const step = STEPS[built.states.get(message.messageId)];
  built.moved = null;
  if (scenario.pendingJournal) {
    const measured = await openInstance(fixture, side);
    fixture.clock.advance(1_000);
    const crash = async point => { if (point === "after-journal") throw new Error("probe crash"); };
    const { service } = await openInstance(fixture, side, { failAt: crash });
    const before = fixture.ids.count("generation");
    await step.run(service, fixture, message.messageId).then(() => { throw new Error("the step did not stop at its journal"); },
      error => { if (error.message !== "probe crash") throw error; });
    if (fixture.ids.count("generation") !== before + 1) throw new Error("the stopped step wrote other than its receipt");
    built.states.set(message.messageId, step.next);
    built.pending = { messageId: message.messageId, event: step.event, published: false };
    // The receipt the journal decided, generation and all: finishing it writes nothing new.
    built.moved = { id: side.receiptId(message.messageId, "reader"), state: step.next,
      generation: fixture.ids.nameOf("generation", before + 1) };
    return measured;
  }
  if (step !== undefined) {
    fixture.clock.advance(1_000);
    await step.run((await openInstance(fixture, side)).service, fixture, message.messageId);
    built.states.set(message.messageId, step.next);
    built.receipts = await receiptStates(fixture, side);
    built.eventCursor = (await eventsAfter(fixture, side, built.eventCursor)).cursor;
  }
  return openInstance(fixture, side);
}

async function operate(built, input) {
  const message = built.messages[built.next++];
  if (message === undefined) throw new Error("the transaction scenario has fewer messages than calls");
  built.target = message.messageId;
  if (built.scenario.operation === "read") return input.service.readReceipt(offer(built.fixture, message.messageId));
  // Each write offers a message not offered before, so each commits a transition.
  return input.service.recordOfferSucceeded(offer(built.fixture, message.messageId));
}

async function validate(built, result, input) {
  const failures = [], { fixture, side } = built, write = built.scenario.operation === "write";
  // A write writes its receipt once; a read writes nothing, finishing a stopped step included.
  const written = fixture.ids.count("generation") - built.generations;
  if (written !== (write ? 1 : 0)) failures.push(`transaction: the call wrote ${written} record(s), not ${write ? 1 : 0}`);
  const expected = write ? "offered" : built.states.get(built.target);
  if (result?.messageId !== built.target || result?.recipientParticipantId !== "reader" || result?.state !== expected) {
    failures.push(`transaction: returned ${result?.messageId} ${result?.state}, not ${built.target} ${expected}`);
  }
  // What the measured store shows, before any other store opens and finishes a journal it left open.
  const { events } = await visibleEvents(input.store, built.eventCursor);
  const recovered = await eventsAfter(fixture, side, built.eventCursor), cursor = recovered.cursor;
  // The stopped step's event is the other writer's, whoever finishes it: the read or recovery.
  const stopped = event => built.pending !== null && event.type === built.pending.event
    && event.payload?.messageId === built.pending.messageId;
  const left = recovered.events.length - events.length;
  const leftOwn = recovered.events.slice(events.length).filter(event => !stopped(event)).length;
  if (leftOwn > 0 || left < 0) {
    failures.push(`transaction: the call left ${left} event(s) of its own behind an open journal`);
  }
  if (built.pending && recovered.events.filter(stopped).length !== 1) {
    failures.push("transaction: the stopped step was lost or published twice");
  }
  const own = events.filter(event => !stopped(event));
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
  const now = await receiptStates(fixture, side);
  const moved = write ? { id: side.receiptId(built.target, "reader"), state: "offered",
    generation: fixture.ids.nameOf("generation", built.generations + 1) } : built.moved;
  for (const [id, before] of built.receipts) {
    const after = now.get(id);
    if (id === moved?.id) {
      if (after?.state !== moved.state) failures.push(`transaction: ${before.messageId} is ${after?.state}, not ${moved.state}`);
      else if (after.generation !== moved.generation) {
        failures.push(`transaction: ${before.messageId} has generation ${after.generation}, not ${moved.generation}`);
      }
    } else if (after?.state !== before.state || after?.generation !== before.generation) {
      failures.push(`transaction: an unrelated receipt for ${before.messageId} changed`);
    }
  }
  for (const id of now.keys()) if (!built.receipts.has(id)) failures.push(`transaction: receipt ${id} appeared`);
  const others = await stateDigest(fixture, side, OTHER_KINDS);
  if (others !== built.others) failures.push("transaction: the call changed records other than its receipt");
  built.others = others;
  if (write) built.states.set(built.target, "offered");
  built.pending = null;
  built.receipts = now;
  built.eventCursor = cursor;
  return failures;
}

// What one call touched, measured on a separate untimed call of the code the child measures.
async function observe(built, run = operate) {
  const helper = path.resolve(import.meta.dirname, "..", "..", "..", "tests", "helpers", "store-io-probe.mjs");
  const { createStoreIoProbe } = await import(pathToFileURL(helper).href);
  const input = await prepare(built), probe = createStoreIoProbe(built.fixture.root);
  let measured;
  try { measured = await probe.capture(() => run(built, input)); } finally { probe.stop(); }
  const enumerations = Object.fromEntries(Object.entries(measured.io).filter(([key]) => /\/readdir(Entries)?$/.test(key)));
  return { failures: await validate(built, measured.result, input), events: built.events, stateReads: measured.stateReads,
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
  // Steps another message's receipt, where a read must change nothing, and returns that receipt.
  "advances-on-read": async () => async (built, input) => {
    const intended = built.messages[built.next++];
    built.target = intended.messageId;
    const other = built.messages.find(item => item !== intended && STEPS[built.states.get(item.messageId)]);
    const step = STEPS[built.states.get(other.messageId)];
    await step.run(input.service, built.fixture, other.messageId);
    // What the store now holds, so later steps start from it.
    built.states.set(other.messageId, step.next);
    return input.service.readReceipt(offer(built.fixture, other.messageId));
  },
  // Answers from the receipts as first built, missing every step since.
  "stale-state": async operate => async (built, input) => {
    const result = await operate(built, input);
    return { ...result, state: built.initial.get(built.target) };
  },
  // Rewrites the target message's body while reading its receipt.
  "rewrites-message": async operate => async (built, input) => {
    const result = await operate(built, input);
    await rewriteMessage(input.store, built.target);
    return result;
  },
  // Rewrites the target receipt as it stands after a correct read.
  "rewrites-receipt": async operate => async (built, input) => {
    const result = await operate(built, input);
    await rewriteReceipt(input.store, built.side.receiptId(built.target, "reader"));
    return result;
  },
  // Answers without reading the store at all.
  "constant-state": async () => async built => {
    const message = built.messages[built.next++];
    built.target = message.messageId;
    return { messageId: message.messageId, recipientParticipantId: "reader", state: "queued" };
  },
};
// The same record once more, in a transaction of its own and without an event.
const rewriteReceipt = (store, id) => store.transaction(tx => {
  tx.put("receipt", id, tx.get("receipt", id), tx.generationOf("receipt", id));
}, { kinds: ["receipt"] });
const rewriteMessage = (store, messageId) => store.transaction(tx => {
  tx.put("message", messageId, { ...tx.get("message", messageId), body: "rewritten" }, tx.generationOf("message", messageId));
}, { kinds: ["message"] });
// A write that stops after its journal, as a crash would, and reports success.
const stopAfterJournal = async (fixture, side, write) => {
  const crash = async point => { if (point === "after-journal") throw new Error("probe crash"); };
  await write((await openInstance(fixture, side, { failAt: crash })).service)
    .catch(error => { if (error.message !== "probe crash") throw error; });
};
// Reads the receipt record as it lies on disk, outside any transaction. Without
// an open journal that is a correct read; with one, it misses the decision.
const recordRead = async () => async (built, input) => {
  const message = built.messages[built.next++];
  built.target = message.messageId;
  return input.store.stateRecord(WORKSPACE, "receipt", built.side.receiptId(message.messageId, "reader"));
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
  // Leaves its decided write behind the journal for the next store that opens.
  "leaves-journal": async () => async built => {
    const message = built.messages[built.next++];
    built.target = message.messageId;
    await stopAfterJournal(built.fixture, built.side, service => service.recordOfferSucceeded(offer(built.fixture, message.messageId)));
    return { messageId: message.messageId, recipientParticipantId: "reader", state: "offered" };
  },
  // Offers the message, then writes its receipt again with the same state.
  "rewrites-receipt": async operate => async (built, input) => {
    const result = await operate(built, input);
    await rewriteReceipt(input.store, built.side.receiptId(built.target, "reader"));
    return result;
  },
  // Commits the offer, but its event one sequence later than the log's next, as a writer
  // that found the sequence before another commit would publish it (#307).
  "skips-a-sequence": async operate => async (built, input) => {
    const result = await operate(built, input);
    const { events } = await visibleEvents(input.store, built.eventCursor);
    const own = events.at(-1), log = path.join(built.fixture.root, "events");
    const later = String(BigInt(own.sequence) + 1n).padStart(own.sequence.length, "0");
    await writeFile(path.join(log, `${later}.json`), `${JSON.stringify({ ...own, sequence: later })}\n`);
    await rm(path.join(log, `${own.sequence}.json`));
    return result;
  },
  "wrong-target": async () => async (built, input) => {
    const intended = built.messages[built.next], other = built.messages[built.next + 1];
    built.next += 2;
    built.target = intended.messageId;
    return input.service.recordOfferSucceeded(offer(built.fixture, other.messageId));
  },
};

export default { name: "transaction", scenario, hash: value => digest(scenario(value)), load: loadStoreSide, build,
  capacity, prepare, operate, validate, observe, recordRead,
  mutationsFor: value => value.operation === "write" ? writeMutations
    : value.pendingJournal ? { ...readMutations, "skips-journal": recordRead } : readMutations,
  dispose: built => built.fixture.dispose() };
