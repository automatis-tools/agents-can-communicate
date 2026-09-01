import path from "node:path";

import { AccError, EXIT, assertPortableId } from "@agents-can-communicate/protocol";

import { encode, listJsonFiles, publishAtomic, readJsonIfPresent } from "./atomic-json.mjs";

const RETENTION_VERSION = 1;
const SEQUENCE_WIDTH = 16;
const pad = value => String(value).padStart(SEQUENCE_WIDTH, "0");

const data = (message, details) => {
  throw new AccError(EXIT.DATA, message, details);
};

function assertMarker(found, expected, filePath) {
  const marker = found.value;
  for (const [key, value] of Object.entries(expected)) {
    if (marker?.[key] !== value) data("retention marker does not match its path", { filePath });
  }
  if (marker.retentionVersion !== RETENTION_VERSION) {
    data("unknown retention marker version", { filePath,
      retentionVersion: marker.retentionVersion });
  }
  return marker;
}

function stateMarker(paths, kind, id, generation) {
  assertPortableId(kind, "record kind");
  assertPortableId(id, "record id");
  assertPortableId(generation, "generation");
  const record = { retentionVersion: RETENTION_VERSION, area: "state", kind, id, generation };
  return { record, filePath: path.join(paths.retained, "state", kind, id,
    `${generation}.json`) };
}

export function stateDeletionPublication(paths, root, kind, id, generation, retainedPath) {
  const marker = stateMarker(paths, kind, id, generation);
  return { path: path.relative(root, marker.filePath), bytes: encode(marker.record),
    replace: false, retainedPath: path.relative(root, retainedPath) };
}

export async function stateGenerationIsDeleted(paths, root, kind, id, generation) {
  const marker = stateMarker(paths, kind, id, generation);
  const found = await readJsonIfPresent(marker.filePath, root);
  if (found === null) return false;
  assertMarker(found, marker.record, marker.filePath);
  return true;
}

function ephemeralDirectory(paths, kind, id) {
  assertPortableId(kind, "ephemeral record kind");
  assertPortableId(id, "ephemeral record id");
  return path.join(paths.retained, "ephemeral", kind, id);
}

async function latestEphemeralMarker(paths, root, kind, id) {
  const directory = ephemeralDirectory(paths, kind, id);
  const filePath = (await listJsonFiles(directory, { root })).at(-1);
  if (filePath === undefined) return null;
  const sequence = path.basename(filePath, ".json");
  const found = await readJsonIfPresent(filePath, root);
  if (found === null) return null;
  return assertMarker(found, { area: "ephemeral", kind, id, sequence }, filePath);
}

export async function ephemeralIsDeleted(paths, root, kind, id) {
  return (await latestEphemeralMarker(paths, root, kind, id))?.state === "deleted";
}

export async function markEphemeral(paths, options, kind, id, state) {
  if (!(state === "present" || state === "deleted")) {
    data("invalid ephemeral retention state", { state });
  }
  const previous = await latestEphemeralMarker(paths, options.root, kind, id);
  const sequence = pad(previous === null ? 1 : Number(previous.sequence) + 1);
  const record = { retentionVersion: RETENTION_VERSION, area: "ephemeral", kind, id,
    sequence, state };
  const filePath = path.join(ephemeralDirectory(paths, kind, id), `${sequence}.json`);
  await publishAtomic(filePath, encode(record), options);
  return record;
}

function completionMarker(paths, transactionId) {
  assertPortableId(transactionId, "transaction id");
  const record = { retentionVersion: RETENTION_VERSION, transactionId };
  return { record, filePath: path.join(paths.retained, "journal", `${transactionId}.json`) };
}

export async function journalIsCompleted(paths, root, transactionId) {
  const marker = completionMarker(paths, transactionId);
  const found = await readJsonIfPresent(marker.filePath, root);
  if (found === null) return false;
  assertMarker(found, marker.record, marker.filePath);
  return true;
}

export async function completeJournal(paths, options, transactionId) {
  const marker = completionMarker(paths, transactionId);
  await publishAtomic(marker.filePath, encode(marker.record), options);
  return marker.record;
}
