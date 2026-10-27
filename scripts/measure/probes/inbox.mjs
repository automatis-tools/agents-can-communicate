// Exact and paged inbox access (#306). The validator reads the store after each
// call: the named message came back, and only its receipt moved.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { digest, multisetFailures, random, shuffle } from "../probe-kit.mjs";
import { loadStoreSide, openStoreFixture, primaryDigest, receiptStates } from "../store-fixture.mjs";

const defaults = { messages: 30, backlog: 30, operation: "exact", limit: 1, seed: 1 };

function scenario(input = {}) {
  const value = { probe: "inbox", ...defaults, ...input };
  for (const key of ["messages", "backlog", "limit", "seed"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error(`inbox ${key} must be a whole number`);
  }
  if (!["exact", "page"].includes(value.operation)) throw new Error("inbox operation is exact or page");
  if (value.messages < 1 || value.limit < 1 || value.limit > 500) throw new Error("inbox needs messages and a limit of 1..500");
  return value;
}

async function build(scenario, side) {
  const fixture = await openStoreFixture(side, ["sender", "reader", "other"], "inbox");
  const order = shuffle([...Array(scenario.messages).fill("reader"), ...Array(scenario.backlog).fill("other")],
    random(scenario.seed));
  const reader = [];
  for (const [index, recipient] of order.entries()) {
    fixture.clock.advance(1_000);
    const message = await fixture.service.sendMessage({ ...fixture.owner("sender"),
      clientMessageId: `client_${index}`, toParticipantIds: [recipient], kind: "note", obligation: "none",
      subject: `${recipient} ${index}`, body: "Same measured fixture" });
    if (recipient === "reader") reader.push({ messageId: message.messageId, sentAt: message.sentAt });
  }
  return { scenario, side, fixture, reader, cursor: 0, target: null,
    expected: await receiptStates(fixture, side), digest: await primaryDigest(fixture) };
}

async function operate(built) {
  const { fixture, scenario } = built;
  if (scenario.operation === "page") {
    return fixture.service.listInbox({ ...fixture.owner("reader"), limit: scenario.limit });
  }
  // Each call reads a message not read before, so every call moves a receipt.
  const target = built.reader[built.cursor++];
  if (target === undefined) throw new Error("the inbox scenario has fewer messages than calls");
  built.target = target.messageId;
  return fixture.service.readInbox({ ...fixture.owner("reader"), messageId: target.messageId });
}

const newestFirst = (a, b) => b.sentAt.localeCompare(a.sentAt) || b.messageId.localeCompare(a.messageId);

async function changes(built, moved) {
  const failures = [], now = await receiptStates(built.fixture, built.side);
  for (const [id, before] of built.expected) {
    const after = now.get(id);
    if (after === undefined) { failures.push(`inbox: receipt for ${before.messageId} disappeared`); continue; }
    if (id === moved) {
      if (after.state !== "retrieved") failures.push(`inbox: ${before.messageId} is ${after.state}, not retrieved`);
    } else if (after.state !== before.state || after.generation !== before.generation) {
      failures.push(`inbox: an unrelated receipt for ${before.messageId} changed`);
    }
  }
  built.expected = now;
  return failures;
}

async function validate(built, result) {
  if (built.scenario.operation === "exact") {
    const failures = [];
    if (!Array.isArray(result) || result.length !== 1) failures.push("inbox: an exact read returns one item");
    else if (result[0].message?.messageId !== built.target) failures.push(`inbox: returned ${result[0].message?.messageId}`);
    else if (result[0].receipt?.state !== "retrieved") failures.push("inbox: the returned receipt is not retrieved");
    return [...failures, ...await changes(built, built.side.receiptId(built.target, "reader"))];
  }
  const listable = built.reader.filter(item => ["queued", "offered"]
    .includes(built.expected.get(built.side.receiptId(item.messageId, "reader"))?.state));
  const wanted = [...listable].sort(newestFirst).slice(0, built.scenario.limit).map(item => item.messageId);
  const failures = [];
  const ids = (result?.items ?? []).map(item => item.message?.messageId);
  if (ids.join() !== wanted.join()) {
    failures.push(...multisetFailures(wanted, ids, "inbox page"));
    if (failures.length === 0) failures.push("inbox page: items are out of order");
  }
  const more = listable.length > built.scenario.limit;
  if (more !== Boolean(result?.nextCursor)) failures.push(`inbox page: cursor ${more ? "missing" : "unexpected"}`);
  return [...failures, ...await changes(built, null)];
}

async function observe(built) {
  const helper = path.resolve(import.meta.dirname, "..", "..", "..", "tests", "helpers", "store-io-probe.mjs");
  const { createStoreIoProbe } = await import(pathToFileURL(helper).href);
  const probe = createStoreIoProbe(built.fixture.root);
  try {
    const measured = await probe.capture(() => operate(built));
    const enumerations = Object.fromEntries(Object.entries(measured.io).filter(([key]) => /\/readdir(Entries)?$/.test(key)));
    return { failures: await validate(built, measured.result), stateReads: measured.stateReads,
      stateByKind: measured.stateByKind, readBytes: measured.readBytes, pageReads: measured.pageReads, enumerations };
  } finally { probe.stop(); }
}

const exactMutations = {
  // Reads the next message while claiming the intended one.
  "wrong-message": async () => async built => {
    const intended = built.reader[built.cursor], other = built.reader[built.cursor + 1];
    built.cursor += 2;
    built.target = intended.messageId;
    return built.fixture.service.readInbox({ ...built.fixture.owner("reader"), messageId: other.messageId });
  },
  // Reports a retrieval that never reached the store.
  "skip-transition": async () => async built => {
    const target = built.reader[built.cursor++];
    built.target = target.messageId;
    return [{ message: { messageId: target.messageId }, receipt: { state: "retrieved" } }];
  },
  "moves-unrelated": async operate => async built => {
    const result = await operate(built);
    await built.fixture.service.readInbox({ ...built.fixture.owner("reader"), messageId: built.reader.at(-1).messageId });
    return result;
  },
  "extra-item": async operate => async built => { const result = await operate(built); return [...result, result[0]]; },
};
const pageMutations = {
  "drops-last": async operate => async built => { const result = await operate(built); return { ...result, items: result.items.slice(0, -1) }; },
  "empty-page": async () => async () => ({ items: [], nextCursor: null }),
  "advances-receipts": async operate => async built => {
    await built.fixture.service.readInbox({ ...built.fixture.owner("reader") });
    return operate(built);
  },
  "reversed-order": async operate => async built => { const result = await operate(built); return { ...result, items: [...result.items].reverse() }; },
};

export default { name: "inbox", scenario, hash: value => digest(scenario(value)), load: loadStoreSide, build, operate,
  validate, observe, mutationsFor: value => value.operation === "exact" ? exactMutations : pageMutations,
  dispose: built => built.fixture.dispose() };
