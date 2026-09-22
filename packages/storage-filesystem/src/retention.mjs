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
  const keys = [...new Set(["retentionVersion", ...Object.keys(expected)])].sort();
  if (marker === null || typeof marker !== "object" || Array.isArray(marker)
    || Object.keys(marker).sort().join("\0") !== keys.join("\0")) {
    data("retention marker is not a closed record", { filePath });
  }
  for (const [key, value] of Object.entries(expected)) {
    if (marker[key] !== value) data("retention marker does not match its path", { filePath });
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

// The newest marker decides a record's state, so only that one is read and
// checked. Every name is still validated first - an unparsable sequence fails
// closed before anything is selected - and names are ordered as numbers, since
// a sequence can outgrow its padding. Reading every marker made each lookup
// cost an open and a full ancestor check per marker ever written: thousands
// for a delivery binding renewed every forty seconds, and seconds for one
// status in a workspace that had been in use for weeks.
async function latestEphemeralMarker(paths, root, kind, id) {
  const directory = ephemeralDirectory(paths, kind, id);
  const named = (await listJsonFiles(directory, { root })).map(filePath => {
    const sequence = path.basename(filePath, ".json");
    if (typeof sequence !== "string" || !/^\d+$/.test(sequence)
      || BigInt(sequence) < 1n || sequence !== pad(BigInt(sequence))) {
      data("invalid ephemeral retention marker", { filePath });
    }
    return { filePath, sequence, order: BigInt(sequence) };
  }).sort((left, right) => (left.order < right.order ? 1 : left.order > right.order ? -1 : 0));
  for (const { filePath, sequence } of named) {
    const found = await readJsonIfPresent(filePath, root);
    if (found === null) continue;
    const marker = found.value;
    if (!(marker?.state === "present" || marker?.state === "deleted")) {
      data("invalid ephemeral retention marker", { filePath });
    }
    assertMarker(found, { area: "ephemeral", kind, id, sequence, state: marker.state }, filePath);
    return marker;
  }
  return null;
}

export async function ephemeralIsDeleted(paths, root, kind, id) {
  return (await latestEphemeralMarker(paths, root, kind, id))?.state === "deleted";
}

export async function markEphemeral(paths, options, kind, id, state) {
  if (!(state === "present" || state === "deleted")) {
    data("invalid ephemeral retention state", { state });
  }
  const previous = await latestEphemeralMarker(paths, options.root, kind, id);
  // A marker that repeats the current state changes nothing, and every renewal
  // of a live record used to append one. History now grows only with a real
  // change: published after a deletion, or deleted.
  if (previous?.state === state) return previous;
  const sequence = pad(previous === null ? 1n : BigInt(previous.sequence) + 1n);
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

export async function completeJournal(paths, options, transactionId) {
  const marker = completionMarker(paths, transactionId);
  await publishAtomic(marker.filePath, encode(marker.record), options);
  return marker.record;
}
