// A filesystem store built through a side's own coordination service, for the
// probes that measure store paths (#306, #307). Clock and ids are fixed here, so
// both sides build the same records from the same scenario.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { digest, pad } from "./probe-kit.mjs";

export const WORKSPACE = "workspace_probe";
const START = "2026-10-26T12:00:00.000Z";

export function fixedClock(start = START) {
  let current = Date.parse(start);
  return { now: () => new Date(current).toISOString(),
    advance: milliseconds => { current += milliseconds; return new Date(current).toISOString(); } };
}

export function fixedIds(prefix = "") {
  const counters = new Map();
  return { next(kind) {
    const value = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, value);
    return `${kind}_${prefix}${pad(value)}`;
  } };
}

const module = (root, ...parts) => import(pathToFileURL(path.join(root, "packages", ...parts)).href);

export async function loadStoreSide(root) {
  const [{ openFilesystemStore }, { createCoordinationService }, { receiptId }] = await Promise.all([
    module(root, "storage-filesystem", "src", "store.mjs"), module(root, "core", "src", "service.mjs"),
    module(root, "core", "src", "conversations.mjs")]);
  return { root, openFilesystemStore, createCoordinationService, receiptId };
}

/** A new store and service on an existing root, as a fresh hook process would open them. */
export async function openInstance(fixture, side, options = {}) {
  const store = await side.openFilesystemStore({ root: fixture.root, workspaceId: WORKSPACE,
    clock: fixture.clock, ids: fixture.ids, ...options });
  return { store, service: side.createCoordinationService({ store, clock: fixture.clock, ids: fixture.ids }) };
}

/** A store, its service and open sessions for each participant named. */
export async function openStoreFixture(side, participants, prefix) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), `acc-probe-${prefix}-`)));
  const clock = fixedClock(), ids = fixedIds();
  const fixture = { root, clock, ids, sessions: {} };
  Object.assign(fixture, await openInstance(fixture, side));
  for (const participantId of participants) {
    fixture.sessions[participantId] = await fixture.service.openSession({ workspaceId: WORKSPACE, participantId,
      harness: "probe", heartbeatCadenceMs: 60_000 });
  }
  fixture.owner = participant => ({ workspaceId: WORKSPACE, sessionId: fixture.sessions[participant].sessionId,
    generation: fixture.sessions[participant].generation });
  fixture.dispose = () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return fixture;
}

/** Every receipt with its generation, read through a fresh store: a cache in the measured one proves nothing. */
export async function receiptStates(fixture, side) {
  const { store } = await openInstance(fixture, side);
  return store.transaction(tx => new Map(tx.list("receipt").map(receipt => {
    const id = side.receiptId(receipt.messageId, receipt.recipientParticipantId);
    return [id, { messageId: receipt.messageId, recipient: receipt.recipientParticipantId,
      state: receipt.state, generation: tx.generationOf("receipt", id) }];
  })), { kinds: ["receipt"] });
}

/** Published events after a cursor, read through a fresh store. */
export async function eventsAfter(fixture, side, cursor) {
  const { store } = await openInstance(fixture, side);
  const events = [];
  for (let after = cursor; ;) {
    const page = await store.eventsSince(WORKSPACE, after, 500);
    events.push(...page.events);
    if (page.events.length === 0) return { events, cursor: after };
    after = page.cursor;
  }
}

/** A digest of what the records mean - sessions, messages, receipts and the event log - not their file layout. */
export async function primaryDigest(fixture, side) {
  const { store } = await openInstance(fixture, side);
  const records = await store.transaction(tx => ({
    // Ordered by participant: session ids are random, and would order differently each build.
    sessions: tx.list("session").map(session => [session.participantId, session.sessionId, session.state]).sort(),
    messages: tx.list("message").map(message => [message.messageId, message.fromParticipantId,
      message.toParticipantIds, message.kind, message.obligation, message.subject, message.body, message.sentAt]).sort(),
    receipts: tx.list("receipt").map(receipt => [receipt.messageId, receipt.recipientParticipantId,
      receipt.state]).sort(),
  }), { kinds: ["session", "message", "receipt"] });
  const { events } = await eventsAfter(fixture, side, null);
  // Session ids and generations are random by design; each is named by its participant.
  let text = JSON.stringify({ ...records, events: events.map(event =>
    [event.sequence, event.type, event.actorSessionId, event.payload]) });
  for (const [participant, session] of Object.entries(fixture.sessions)) {
    text = text.replaceAll(session.sessionId, `session:${participant}`).replaceAll(session.generation, `generation:${participant}`);
  }
  return digest(text);
}
