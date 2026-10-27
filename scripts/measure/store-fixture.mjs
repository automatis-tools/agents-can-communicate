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

export function fixedIds() {
  const counters = new Map();
  return { next(kind) {
    const value = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, value);
    return `${kind}_${pad(value)}`;
  } };
}

const module = (root, ...parts) => import(pathToFileURL(path.join(root, "packages", ...parts)).href);

export async function loadStoreSide(root) {
  const [{ openFilesystemStore }, { createCoordinationService }, { receiptId }] = await Promise.all([
    module(root, "storage-filesystem", "src", "store.mjs"), module(root, "core", "src", "service.mjs"),
    module(root, "core", "src", "conversations.mjs")]);
  return { root, openFilesystemStore, createCoordinationService, receiptId };
}

/** A store, its service and open sessions for each participant named. */
export async function openStoreFixture(side, participants, prefix) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), `acc-probe-${prefix}-`)));
  const clock = fixedClock(), ids = fixedIds();
  const store = await side.openFilesystemStore({ root, workspaceId: WORKSPACE, clock, ids });
  const service = side.createCoordinationService({ store, clock, ids });
  const sessions = {};
  for (const participantId of participants) {
    sessions[participantId] = await service.openSession({ workspaceId: WORKSPACE, participantId,
      harness: "probe", heartbeatCadenceMs: 60_000 });
  }
  return { root, clock, ids, store, service, sessions,
    owner: participant => ({ workspaceId: WORKSPACE, sessionId: sessions[participant].sessionId,
      generation: sessions[participant].generation }),
    dispose: () => rm(root, { recursive: true, force: true }) };
}

/** Every receipt with its generation, read through the side's store. */
export async function receiptStates(fixture, side) {
  return fixture.store.transaction(tx => new Map(tx.list("receipt").map(receipt => {
    const id = side.receiptId(receipt.messageId, receipt.recipientParticipantId);
    return [id, { messageId: receipt.messageId, recipient: receipt.recipientParticipantId,
      state: receipt.state, generation: tx.generationOf("receipt", id) }];
  })), { kinds: ["receipt"] });
}

/** A digest of the primary records' meaning: messages and receipts, not their file layout. */
export async function primaryDigest(fixture) {
  return fixture.store.transaction(tx => digest({
    messages: tx.list("message").map(message => [message.messageId, message.fromParticipantId,
      message.toParticipantIds, message.kind, message.obligation, message.subject, message.sentAt]).sort(),
    receipts: tx.list("receipt").map(receipt => [receipt.messageId, receipt.recipientParticipantId,
      receipt.state]).sort(),
  }), { kinds: ["message", "receipt"] });
}
