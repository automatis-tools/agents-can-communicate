// Exact and paged inbox access (#306). Every call opens its own store, as a
// hook process does, and the validator reads back through another fresh one:
// the message that came back, the receipt that moved, the event it published.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { digest, multisetFailures, random, shuffle } from "../probe-kit.mjs";
import { eventsAfter, loadStoreSide, openInstance, openStoreFixture, primaryDigest, receiptStates }
  from "../store-fixture.mjs";

// `limit` 20 is the product's default page; `mix` spreads obligations and receipt states.
const defaults = { messages: 30, backlog: 30, operation: "exact", limit: 20, mix: true, seed: 1 };
const OBLIGATIONS = ["none", "acknowledge", "reply"];
// The message kind each obligation belongs to in the protocol.
const KIND = { none: "note", acknowledge: "decision", reply: "question" };

function scenario(input = {}) {
  const value = { probe: "inbox", ...defaults, ...input };
  for (const key of ["messages", "backlog", "limit", "seed"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error(`inbox ${key} must be a whole number`);
  }
  if (!["exact", "page"].includes(value.operation)) throw new Error("inbox operation is exact or page");
  if (typeof value.mix !== "boolean") throw new Error("inbox mix is true or false");
  if (value.messages < 1 || value.limit < 1 || value.limit > 500) throw new Error("inbox needs messages and a limit of 1..500");
  return value;
}

const listable = (state, obligation) => state === "queued" || state === "offered"
  || (state === "retrieved" && obligation !== "none");

async function build(scenario, side) {
  const fixture = await openStoreFixture(side, ["sender", "reader", "other"], "inbox");
  const next = random(scenario.seed);
  const order = shuffle([...Array(scenario.messages).fill("reader"), ...Array(scenario.backlog).fill("other")], next);
  const reader = [];
  for (const [index, recipient] of order.entries()) {
    fixture.clock.advance(1_000);
    const obligation = scenario.mix ? OBLIGATIONS[Math.floor(next() * 3)] : "none";
    const sent = { clientMessageId: `client_${index}`, toParticipantIds: [recipient],
      kind: KIND[obligation], obligation, subject: `${recipient} ${index}`,
      body: `Body ${index} for ${recipient}` };
    const message = await fixture.service.sendMessage({ ...fixture.owner("sender"), ...sent });
    if (recipient === "reader") reader.push({ ...sent, messageId: message.messageId, sentAt: message.sentAt });
  }
  // Receipts the reader has already moved, through the product's own operations.
  // In turn, so every state appears; a reply-obligation message is never acknowledged without a reply.
  const STATES = ["queued", "offered", "retrieved", "acknowledged"];
  for (const [index, item] of reader.entries()) {
    const state = scenario.mix ? STATES[index % STATES.length] : "queued";
    item.state = item.obligation === "reply" && state === "acknowledged" ? "queued" : state;
    if (item.state === "offered") {
      await fixture.service.recordOfferSucceeded({ messageId: item.messageId, recipientParticipantId: "reader",
        targetSessionId: fixture.sessions.reader.sessionId, targetGeneration: fixture.sessions.reader.generation,
        transport: "next-turn", adapterId: "probe", clientVersion: "1.0.0" });
    }
    if (item.state === "retrieved" || item.state === "acknowledged") {
      await fixture.service.readInbox({ ...fixture.owner("reader"), messageId: item.messageId });
    }
    if (item.state === "acknowledged") {
      await fixture.service.acknowledgeMessage({ ...fixture.owner("reader"), messageId: item.messageId });
    }
  }
  const { cursor } = await eventsAfter(fixture, side, null);
  return { scenario, side, fixture, reader, next: 0, target: null, eventCursor: cursor,
    receipts: await receiptStates(fixture, side), digest: await primaryDigest(fixture, side) };
}

const capacity = value => value.operation === "exact" ? value.messages : Infinity;
const prepare = async built => openInstance(built.fixture, built.side);

async function operate(built, input) {
  const { fixture, scenario } = built;
  if (scenario.operation === "page") return input.service.listInbox({ ...fixture.owner("reader"), limit: scenario.limit });
  // Each call reads a message not read before.
  const target = built.reader[built.next++];
  if (target === undefined) throw new Error("the inbox scenario has fewer messages than calls");
  built.target = target;
  return input.service.readInbox({ ...fixture.owner("reader"), messageId: target.messageId });
}

const newestFirst = (a, b) => b.sentAt.localeCompare(a.sentAt) || b.messageId.localeCompare(a.messageId);
const FIELDS = ["messageId", "subject", "body", "kind", "obligation"];
// The published page contract: at most this many bytes of page JSON, formatted with two spaces.
const PAGE_BYTES = 12_000;
const pageBytes = value => Buffer.byteLength(JSON.stringify(value, null, 2));

// Receipts and events after a call, against what the call may change.
async function storeChanges(built, moved) {
  const failures = [], now = await receiptStates(built.fixture, built.side);
  for (const [id, before] of built.receipts) {
    const after = now.get(id), expected = moved?.id === id ? moved.state : before.state;
    if (after === undefined) failures.push(`inbox: receipt for ${before.messageId} disappeared`);
    else if (after.state !== expected) failures.push(`inbox: ${before.messageId} is ${after.state}, not ${expected}`);
    else if ((after.generation !== before.generation) !== (expected !== before.state)) {
      failures.push(`inbox: receipt for ${before.messageId} was ${expected === before.state ? "rewritten" : "not rewritten"}`);
    }
  }
  for (const id of now.keys()) if (!built.receipts.has(id)) failures.push(`inbox: receipt ${id} appeared`);
  const { events, cursor } = await eventsAfter(built.fixture, built.side, built.eventCursor);
  const wanted = moved && moved.state !== built.receipts.get(moved.id)?.state ? 1 : 0;
  if (events.length !== wanted) failures.push(`inbox: the call published ${events.length} event(s), not ${wanted}`);
  else if (wanted === 1 && (events[0].type !== "message.retrieved" || events[0].payload?.messageId !== built.target.messageId)) {
    failures.push(`inbox: the call published ${events[0].type} for ${events[0].payload?.messageId}`);
  }
  built.receipts = now;
  built.eventCursor = cursor;
  return failures;
}

async function validateExact(built, result) {
  const target = built.target, failures = [];
  const id = built.side.receiptId(target.messageId, "reader");
  const before = built.receipts.get(id)?.state;
  const after = before === "acknowledged" || before === "retrieved" ? before : "retrieved";
  if (!Array.isArray(result) || result.length !== 1) failures.push("inbox: an exact read returns one item");
  else {
    for (const field of FIELDS) {
      if (result[0].message?.[field] !== target[field]) failures.push(`inbox: returned ${field} ${JSON.stringify(result[0].message?.[field])}`);
    }
    const receipt = result[0].receipt;
    if (receipt?.messageId !== target.messageId || receipt?.recipientParticipantId !== "reader") {
      failures.push(`inbox: returned the receipt of ${receipt?.messageId} for ${receipt?.recipientParticipantId}`);
    } else if (receipt.state !== after) failures.push(`inbox: the returned receipt is ${receipt.state}, not ${after}`);
  }
  failures.push(...await storeChanges(built, { id, state: after }));
  target.state = after;
  return failures;
}

async function validatePage(built, result) {
  const failures = [], { scenario } = built;
  const wanted = built.reader.filter(item => listable(built.receipts.get(built.side.receiptId(item.messageId, "reader"))?.state,
    item.obligation)).sort(newestFirst);
  const items = Array.isArray(result?.items) ? result.items : [];
  const k = items.length, full = Math.min(scenario.limit, wanted.length);
  if (k > full || (wanted.length > 0 && k < 1)) failures.push(`inbox page: ${k} items for a limit of ${scenario.limit}`);
  const ids = items.map(item => item.message?.messageId);
  const prefix = wanted.slice(0, k);
  if (ids.join() !== prefix.map(item => item.messageId).join()) {
    failures.push(...multisetFailures(prefix.map(item => item.messageId), ids, "inbox page"));
    if (failures.length === 0) failures.push("inbox page: items are out of order");
  } else {
    for (const [index, item] of items.entries()) {
      if (item.message?.subject !== prefix[index].subject) failures.push(`inbox page: item ${index} has another subject`);
      const state = built.receipts.get(built.side.receiptId(prefix[index].messageId, "reader"))?.state;
      if (item.receipt?.messageId !== prefix[index].messageId || item.receipt?.recipientParticipantId !== "reader") {
        failures.push(`inbox page: item ${index} carries the receipt of ${item.receipt?.messageId}`);
      } else if (item.receipt.state !== state) failures.push(`inbox page: item ${index} reports ${item.receipt.state}, not ${state}`);
    }
  }
  const cursor = k < wanted.length ? wanted[k - 1]?.messageId ?? null : null;
  if ((result?.nextCursor ?? null) !== cursor) failures.push(`inbox page: cursor ${result?.nextCursor}, not ${cursor}`);
  else if (cursor !== null) {
    // The cursor continues where this page ended.
    const { service } = await openInstance(built.fixture, built.side);
    const following = await service.listInbox({ ...built.fixture.owner("reader"), limit: 1, cursor });
    const [next] = following.items;
    if (next?.message?.messageId !== wanted[k].messageId) failures.push("inbox page: the cursor does not continue the page");
    // A page holds `limit` items, or every listable one, unless the next would take it
    // past the byte budget: measured with the next item exactly as a page carries it.
    else if (k < full && pageBytes({ ...result, items: [...items, next], nextCursor: next.message.messageId }) <= PAGE_BYTES) {
      failures.push(`inbox page: ${k} items where ${k + 1} fit the ${PAGE_BYTES}-byte page`);
    }
  }
  return [...failures, ...await storeChanges(built, null)];
}

const validate = async (built, result) => built.scenario.operation === "exact"
  ? validateExact(built, result) : validatePage(built, result);

async function observe(built) {
  const helper = path.resolve(import.meta.dirname, "..", "..", "..", "tests", "helpers", "store-io-probe.mjs");
  const { createStoreIoProbe } = await import(pathToFileURL(helper).href);
  const input = await prepare(built), probe = createStoreIoProbe(built.fixture.root);
  let measured;
  try { measured = await probe.capture(() => operate(built, input)); } finally { probe.stop(); }
  const enumerations = Object.fromEntries(Object.entries(measured.io).filter(([key]) => /\/readdir(Entries)?$/.test(key)));
  return { failures: await validate(built, measured.result), stateReads: measured.stateReads,
    stateByKind: measured.stateByKind, readBytes: measured.readBytes, pageReads: measured.pageReads, enumerations };
}

const full = item => Object.fromEntries(FIELDS.map(field => [field, item[field]]));
const exactMutations = {
  // Reads the next message while claiming the intended one.
  "wrong-message": async () => async (built, input) => {
    const intended = built.reader[built.next], other = built.reader[built.next + 1];
    built.next += 2;
    built.target = intended;
    return input.service.readInbox({ ...built.fixture.owner("reader"), messageId: other.messageId });
  },
  // Reports a retrieval that never reached the store.
  "skip-transition": async () => async built => {
    const target = built.reader[built.next++];
    built.target = target;
    return [{ message: full(target),
      receipt: { messageId: target.messageId, recipientParticipantId: "reader", state: "retrieved" } }];
  },
  // Moves the receipt but publishes no event for it.
  "no-event": async () => async (built, input) => {
    const target = built.reader[built.next++], id = built.side.receiptId(target.messageId, "reader");
    built.target = target;
    const receipt = await input.store.transaction(tx => {
      const current = tx.get("receipt", id), moved = { ...current, state: "retrieved" };
      if (current.state !== "retrieved" && current.state !== "acknowledged") tx.put("receipt", id, moved, tx.generationOf("receipt", id));
      return moved;
    }, { kinds: ["receipt"] });
    return [{ message: full(target), receipt }];
  },
  "summary-for-body": async operate => async (built, input) => {
    const result = await operate(built, input);
    return result.map(item => ({ ...item, message: { ...item.message, body: undefined } }));
  },
  "moves-unrelated": async operate => async (built, input) => {
    const result = await operate(built, input);
    const other = built.reader.slice(built.next).find(item => item.state === "queued" || item.state === "offered");
    if (other) await input.service.readInbox({ ...built.fixture.owner("reader"), messageId: other.messageId });
    return result;
  },
  "extra-item": async operate => async (built, input) => { const result = await operate(built, input); return [...result, result[0]]; },
  // The right message with the receipt of another one in the same state.
  "foreign-receipt": async operate => async (built, input) => {
    const [item] = await operate(built, input);
    const other = (await receiptStates(built.fixture, built.side)).values()
      .find(receipt => receipt.messageId !== built.target.messageId && receipt.state === item.receipt.state);
    return [{ ...item, receipt: { ...item.receipt, messageId: other.messageId, recipientParticipantId: other.recipient } }];
  },
  // Writes a message to the reader while reading one, so a receipt appears.
  "creates-receipt": async operate => async (built, input) => {
    const result = await operate(built, input);
    await input.service.sendMessage({ ...built.fixture.owner("sender"), clientMessageId: `extra_${built.next}`,
      toParticipantIds: ["reader"], kind: "note", obligation: "none", subject: "extra", body: "extra" });
    return result;
  },
};
const pageMutations = {
  "drops-last": async operate => async (built, input) => {
    const result = await operate(built, input);
    return { ...result, items: result.items.slice(0, -1) };
  },
  "empty-page": async () => async () => ({ items: [], nextCursor: null }),
  "advances-receipts": async operate => async (built, input) => {
    await input.service.readInbox({ ...built.fixture.owner("reader") });
    return operate(built, input);
  },
  "reversed-order": async operate => async (built, input) => {
    const result = await operate(built, input);
    return { ...result, items: [...result.items].reverse() };
  },
  "garbage-cursor": async operate => async (built, input) => {
    const result = await operate(built, input);
    return { ...result, nextCursor: built.reader[0].messageId };
  },
  // Lists every message addressed to the reader, whatever its receipt says.
  "ignores-receipt-state": async () => async built => {
    const items = [...built.reader].sort(newestFirst).slice(0, built.scenario.limit)
      .map(item => ({ message: { messageId: item.messageId, subject: item.subject },
        receipt: { messageId: item.messageId, recipientParticipantId: "reader", state: "queued" } }));
    return { items, nextCursor: built.reader.length > items.length ? items.at(-1).message.messageId : null };
  },
  // Always one item short of a full page, with a cursor that continues it.
  "short-page": async operate => async (built, input) => {
    const result = await operate(built, input);
    if (result.items.length < 2) return { ...result, items: [], nextCursor: null };
    const items = result.items.slice(0, -1);
    return { ...result, items, nextCursor: items.at(-1).message.messageId };
  },
};

export default { name: "inbox", scenario, hash: value => digest(scenario(value)), load: loadStoreSide, build, capacity,
  prepare, operate, validate, observe, mutationsFor: value => value.operation === "exact" ? exactMutations : pageMutations,
  dispose: built => built.fixture.dispose() };
