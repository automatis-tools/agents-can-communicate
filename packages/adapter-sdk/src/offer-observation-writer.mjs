import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parentPort, workerData as input } from "node:worker_threads";
import { readSessionRecord, withWriterMutex } from "@agents-can-communicate/storage-filesystem";
import { loadOfferObservation, offerObservationPath, OFFER_ERRORS } from "./offer-observation.mjs";
import { validOfferOrder } from "./offer-observation-order.mjs";

async function write() {
  const { runtimeDir: root, workspaceId, sessionId, generation, at, order, state, reasonCode, deadlineAt } = input;
  const file = offerObservationPath(root, sessionId);
  if (!validOfferOrder(order) || !Number.isFinite(Date.parse(at)) || !["active", "degraded"].includes(state)
    || !(reasonCode === null || OFFER_ERRORS.includes(reasonCode))) return false;
  const check = () => { if (Date.now() >= deadlineAt) throw new Error("observation deadline"); };
  check();
  return withWriterMutex({ locks: path.join(root, "offer-observation-locks", sessionId) },
    { root, deadlineAt, clock: { now: () => new Date().toISOString() } }, async () => {
      check();
      const session = await readSessionRecord({ root, workspaceId, sessionId });
      if (session?.state !== "open" || session.generation !== generation) return false;
      const previous = await loadOfferObservation(input);
      if (previous && (Date.parse(previous.at) > Date.parse(at)
        || (Date.parse(previous.at) === Date.parse(at) && previous.order !== undefined
          && BigInt(previous.order) >= BigInt(order)))) return false;
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        check();
        await writeFile(temporary, JSON.stringify({ schemaVersion: 1, sessionId, generation,
          at, order, state, reasonCode }) + "\n", { mode: 0o600 });
        check();
        await rename(temporary, file);
        return true;
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    });
}
parentPort.postMessage(await write().catch(() => false));
