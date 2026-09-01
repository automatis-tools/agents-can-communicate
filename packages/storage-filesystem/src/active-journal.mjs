import { createHash } from "node:crypto";
import { constants } from "node:fs";
import path from "node:path";

import { AccError, EXIT, assertPortableId } from "@agents-can-communicate/protocol";

import { encode, publishAtomic } from "./atomic-json.mjs";
import { withRegularNoFollow } from "./safe-file.mjs";

const ACTIVE_JOURNAL_VERSION = 2;
const AUTHORITY_BYTES_LIMIT = 1024;
const GENERATION_WIDTH = 16;
const READ_ATTEMPTS = 4;

const data = (message, details) => {
  throw new AccError(EXIT.DATA, message, details);
};

export function activeJournalPath(paths, slot) {
  if (slot !== 0 && slot !== 1) data("invalid active journal slot", { slot });
  return path.join(paths.journal, `active.${slot}`);
}

function exactKeys(value, expected, filePath) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) {
    data("active journal record is not closed", { filePath });
  }
}

function checksum(record) {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function encodeAuthority(record) {
  return encode({ activeJournalChecksum: checksum(record), record });
}

function validateActiveRecord(record, filePath) {
  const base = ["activeJournalVersion", "generation", "previousChecksum", "state"];
  if (record?.state === "idle") exactKeys(record, base, filePath);
  else if (record?.state === "open") {
    exactKeys(record, [...base, "transactionId", "firstSequence"], filePath);
  } else data("invalid active journal state", { filePath, state: record?.state });

  if (record.activeJournalVersion !== ACTIVE_JOURNAL_VERSION) {
    data("unknown active journal version", { filePath,
      activeJournalVersion: record.activeJournalVersion });
  }
  if (typeof record.generation !== "string"
    || !/^\d{16}$/.test(record.generation)) {
    data("invalid active journal generation", { filePath, generation: record.generation });
  }
  const generation = BigInt(record.generation);
  if (generation === 0n) {
    if (record.state !== "idle" || record.previousChecksum !== null) {
      data("invalid active journal genesis", { filePath });
    }
  } else if (typeof record.previousChecksum !== "string"
    || !/^[0-9a-f]{64}$/.test(record.previousChecksum)) {
    data("invalid active journal previous checksum", { filePath });
  }
  if (record.state === "open") {
    assertPortableId(record.transactionId, "transaction id");
    if (typeof record.firstSequence !== "string"
      || !/^\d{16}$/.test(record.firstSequence)) {
      data("invalid active journal first sequence", { filePath,
        firstSequence: record.firstSequence });
    }
  }
  return generation;
}

function decodeAuthority(bytes, filePath, slot) {
  let envelope;
  try {
    envelope = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    data("invalid active journal authority", { filePath, cause: error.message });
  }
  exactKeys(envelope, ["activeJournalChecksum", "record"], filePath);
  const generation = validateActiveRecord(envelope.record, filePath);
  if (Number(generation % 2n) !== slot) {
    data("active journal generation chain is invalid", { filePath,
      generation: envelope.record.generation, slot });
  }
  if (typeof envelope.activeJournalChecksum !== "string"
    || envelope.activeJournalChecksum !== checksum(envelope.record)) {
    data("active journal checksum mismatch", { filePath });
  }
  if (!bytes.equals(encodeAuthority(envelope.record))) {
    data("active journal authority is not canonical", { filePath });
  }
  return { checksum: envelope.activeJournalChecksum, generation,
    record: envelope.record, slot };
}

async function readSlotBytes(paths, root, slot, openFile) {
  const filePath = activeJournalPath(paths, slot);
  try {
    return await withRegularNoFollow(filePath, root, constants.O_RDONLY,
      async (handle, stat) => {
        if (stat.size < 1 || stat.size > AUTHORITY_BYTES_LIMIT) {
          data("invalid active journal authority size", { filePath, size: stat.size });
        }
        return handle.readFile();
      }, openFile);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function sameBytes(left, right) {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}

// Slot zero is read twice. Because writers alternate slots and generations
// never repeat, equal reads prove that the pair existed at one instant even if
// another process published between descriptor opens.
async function readStableSlots(paths, root, openFile) {
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    const slot0 = await readSlotBytes(paths, root, 0, openFile);
    const slot1 = await readSlotBytes(paths, root, 1, openFile);
    const slot0Confirmation = await readSlotBytes(paths, root, 0, openFile);
    if (sameBytes(slot0, slot0Confirmation)) return [slot0, slot1];
  }
  throw new AccError(EXIT.CONFLICT, "active journal changed while being read", {});
}

function validateTransition(current, previous, filePath) {
  const expected = previous.state === "idle" ? "open" : "idle";
  if (current.state !== expected) {
    data("invalid active journal transition", { filePath,
      previous: previous.state, current: current.state });
  }
}

function compareGenerations(left, right) {
  if (left.generation < right.generation) return -1;
  if (left.generation > right.generation) return 1;
  return 0;
}

function selectAuthority(paths, bytes) {
  // Decode every present slot before selection. Falling back from a corrupt
  // latest slot to an older valid peer would turn corruption into rollback.
  const found = bytes.map((value, slot) => value === null
    ? null
    : decodeAuthority(value, activeJournalPath(paths, slot), slot)).filter(Boolean);
  if (found.length === 0) return null;
  if (found.length === 1) {
    const [only] = found;
    if (only.slot === 0 && only.generation === 0n) return only;
    data("active journal authority peer is missing", { slot: only.slot,
      generation: only.record.generation });
  }
  found.sort(compareGenerations);
  const [previous, current] = found;
  if (current.generation !== previous.generation + 1n) {
    data("active journal generation chain is invalid", {
      previous: previous.record.generation, current: current.record.generation });
  }
  if (current.record.previousChecksum !== previous.checksum) {
    data("active journal checksum chain is invalid", { slot: current.slot });
  }
  validateTransition(current.record, previous.record,
    activeJournalPath(paths, current.slot));
  return current;
}

async function readCurrent(paths, root, openFile) {
  return selectAuthority(paths, await readStableSlots(paths, root, openFile));
}

const genesis = () => ({ activeJournalVersion: ACTIVE_JOURNAL_VERSION,
  generation: "0".repeat(GENERATION_WIDTH), previousChecksum: null, state: "idle" });

export async function initialiseActiveJournal(paths, options) {
  const current = await readCurrent(paths, options.root);
  if (current !== null) return current.record;
  try {
    await publishAtomic(activeJournalPath(paths, 0), encodeAuthority(genesis()), options);
  } catch (error) {
    if (error.code !== EXIT.CONFLICT) throw error;
  }
  return readActiveJournal(paths, options.root);
}

export async function readActiveJournal(paths, root, openFile) {
  const current = await readCurrent(paths, root, openFile);
  if (current === null) data("active journal has no authority", { journal: paths.journal });
  return current.record;
}

function nextGeneration(current) {
  const next = current.generation + 1n;
  const generation = next.toString().padStart(GENERATION_WIDTH, "0");
  if (generation.length !== GENERATION_WIDTH) {
    data("active journal generation is exhausted", { current: current.record.generation });
  }
  return generation;
}

async function appendTransition(paths, options, fields, expected) {
  const current = await readCurrent(paths, options.root, options.openFile);
  if (current === null || !expected(current.record)) {
    throw new AccError(EXIT.CONFLICT, "active journal transition conflicts",
      { current: current?.record ?? null, next: fields });
  }
  const record = { activeJournalVersion: ACTIVE_JOURNAL_VERSION,
    generation: nextGeneration(current), previousChecksum: current.checksum, ...fields };
  validateActiveRecord(record, activeJournalPath(paths, 1 - current.slot));
  await publishAtomic(activeJournalPath(paths, 1 - current.slot), encodeAuthority(record),
    { ...options, tmpDir: options.tmpDir ?? paths.tmp ?? path.join(options.root, "tmp"),
      replace: true });
  return record;
}

export function activateJournal(paths, options, entry) {
  return appendTransition(paths, options, { state: "open",
    transactionId: entry.transactionId, firstSequence: entry.firstSequence },
    current => current.state === "idle");
}

export function idleJournal(paths, options, transactionId) {
  return appendTransition(paths, options, { state: "idle" },
    current => current.state === "open" && current.transactionId === transactionId);
}
