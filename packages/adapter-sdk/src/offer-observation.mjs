import { readFile } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { assertPortableId } from "@agents-can-communicate/protocol";

export const OFFER_ERRORS = Object.freeze(["ambiguous_recipient_sessions", "delivery_disabled",
  "recipient_busy", "recipient_unavailable", "transport_error", "transport_rejected",
  "transport_permission_denied", "unsupported_client_version", "inbound_approval_required"]);

export const offerObservationPath = (runtimeDir, sessionId) => {
  assertPortableId(sessionId, "offer observation session id");
  return path.join(runtimeDir, "offer-observations", `${sessionId}.json`);
};

export async function loadOfferObservation({ runtimeDir, sessionId, generation }) {
  try {
    const record = JSON.parse(await readFile(offerObservationPath(runtimeDir, sessionId), "utf8"));
    if (record.schemaVersion !== 1 || record.sessionId !== sessionId || record.generation !== generation
      || !Number.isFinite(Date.parse(record.at)) || !["active", "degraded"].includes(record.state)
      || !(record.reasonCode === null || OFFER_ERRORS.includes(record.reasonCode))) return null;
    return { at: record.at, state: record.state, reasonCode: record.reasonCode };
  } catch { return null; }
}

/** Optional UI diagnostic, separate from delivery receipts and history. Failure
 * to publish it cannot turn a recorded message into a failed send. */
export async function storeOfferObservation(input) {
  if (typeof input.runtimeDir !== "string" || typeof input.workspaceId !== "string") return false;
  let worker, timer;
  try {
    worker = new Worker(new URL("./offer-observation-writer.mjs", import.meta.url), {
      workerData: { ...input, deadlineAt: Date.now() + 1500 },
    });
    const done = new Promise(resolve => {
      worker.once("message", value => resolve(value === true));
      worker.once("error", () => resolve(false));
      worker.once("exit", () => resolve(false));
      timer = setTimeout(resolve, 1500, false);
    });
    worker.unref();
    return await done;
  } catch { return false; }
  finally { clearTimeout(timer); }
}
