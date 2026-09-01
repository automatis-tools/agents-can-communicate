import { createHash } from "node:crypto";
import { constants } from "node:fs";
import path from "node:path";

import { AccError, EXIT, assertPortableId } from "@agents-can-communicate/protocol";

import { publishAtomic } from "./atomic-json.mjs";
import { withRegularNoFollow } from "./safe-file.mjs";

const ACTIVE_JOURNAL_RECORD_BYTES = 512;
const ACTIVE_JOURNAL_VERSION = 1;
const POINTER_BYTES = 8;

const data = (message, details) => {
  throw new AccError(EXIT.DATA, message, details);
};

export function activeJournalPath(paths) {
  return path.join(paths.journal, "active.log");
}

function exactKeys(record, expected, filePath) {
  if (record === null || typeof record !== "object" || Array.isArray(record)
    || Object.keys(record).sort().join("\0") !== [...expected].sort().join("\0")) {
    data("active journal record is not closed", { filePath });
  }
}

function validateActiveRecord(record, filePath) {
  if (record?.activeJournalVersion !== ACTIVE_JOURNAL_VERSION) {
    data("unknown active journal version", { filePath,
      activeJournalVersion: record?.activeJournalVersion });
  }
  if (record.state === "idle") {
    exactKeys(record, ["activeJournalVersion", "state"], filePath);
    return record;
  }
  if (record.state !== "open") data("invalid active journal state", { filePath });
  exactKeys(record, ["activeJournalVersion", "state", "transactionId", "firstSequence"],
    filePath);
  assertPortableId(record.transactionId, "transaction id");
  if (typeof record.firstSequence !== "string" || !/^\d{16}$/.test(record.firstSequence)) {
    data("invalid active journal first sequence", { filePath,
      firstSequence: record.firstSequence });
  }
  return record;
}

function checksum(record, previous) {
  return createHash("sha256").update(JSON.stringify({ record, previous })).digest("hex");
}

function validateTransition(record, previous, filePath) {
  if (previous === null) {
    if (record.state !== "idle") data("active journal initial record is not idle", { filePath });
    return;
  }
  const expectedPrevious = record.state === "open" ? "idle" : "open";
  if (previous.state !== expectedPrevious) {
    data("invalid active journal transition", { filePath,
      previous: previous.state, next: record.state });
  }
}

function encodeActiveJournalRecord(record, previous = null) {
  validateActiveRecord(record, activeJournalPath({ journal: "<journal>" }));
  if (previous !== null) {
    validateActiveRecord(previous, activeJournalPath({ journal: "<journal>" }));
  }
  validateTransition(record, previous, activeJournalPath({ journal: "<journal>" }));
  const envelope = JSON.stringify({ checksum: checksum(record, previous), previous, record });
  const encoded = Buffer.from(envelope);
  if (encoded.length > ACTIVE_JOURNAL_RECORD_BYTES - POINTER_BYTES) {
    data("active journal record is too large", { bytes: encoded.length });
  }
  const bytes = Buffer.alloc(ACTIVE_JOURNAL_RECORD_BYTES, 0x20);
  encoded.copy(bytes);
  bytes[ACTIVE_JOURNAL_RECORD_BYTES - 1] = 0x0a;
  return bytes;
}

function decodeEnvelope(bytes, filePath) {
  let envelope;
  try {
    envelope = JSON.parse(bytes.toString("utf8").trim());
  } catch (error) {
    data("invalid active journal record", { filePath, cause: error.message });
  }
  exactKeys(envelope, ["checksum", "previous", "record"], filePath);
  if (typeof envelope.checksum !== "string"
    || envelope.checksum !== checksum(envelope.record, envelope.previous)) {
    data("active journal checksum mismatch", { filePath });
  }
  const record = validateActiveRecord(envelope.record, filePath);
  const previous = envelope.previous === null
    ? null
    : validateActiveRecord(envelope.previous, filePath);
  validateTransition(record, previous, filePath);
  return { previous, record };
}

async function readFrame(handle, offset, filePath) {
  const bytes = Buffer.alloc(ACTIVE_JOURNAL_RECORD_BYTES);
  const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
  if (bytesRead !== bytes.length) data("truncated active journal record", { filePath });
  return bytes;
}

async function readCurrent(handle, size, filePath) {
  const completeSize = size - (size % ACTIVE_JOURNAL_RECORD_BYTES);
  if (completeSize < ACTIVE_JOURNAL_RECORD_BYTES) {
    data("active journal has no complete record", { filePath, size });
  }
  const offset = completeSize - ACTIVE_JOURNAL_RECORD_BYTES;
  const bytes = await readFrame(handle, offset, filePath);
  if (bytes[ACTIVE_JOURNAL_RECORD_BYTES - POINTER_BYTES] === 0) {
    let distance = 0n;
    for (let index = ACTIVE_JOURNAL_RECORD_BYTES - POINTER_BYTES + 1;
      index < ACTIVE_JOURNAL_RECORD_BYTES; index += 1) {
      distance = (distance << 8n) | BigInt(bytes[index]);
    }
    const available = BigInt(offset / ACTIVE_JOURNAL_RECORD_BYTES);
    if (distance < 1n || distance > available) {
      data("invalid active journal padding pointer", { filePath });
    }
    const targetOffset = offset - Number(distance) * ACTIVE_JOURNAL_RECORD_BYTES;
    const target = await readFrame(handle, targetOffset, filePath);
    return decodeFrame(target, targetOffset, filePath);
  }
  return decodeFrame(bytes, offset, filePath);
}

function decodeFrame(bytes, offset, filePath) {
  // A short tail cannot hold a pointer. Its otherwise-complete transition
  // envelope carries the checksummed prior state, so closing it with zero is
  // sufficient to retain the prior authority without another filesystem read.
  if (bytes.at(-1) === 0) {
    const completed = Buffer.from(bytes);
    completed[completed.length - 1] = 0x0a;
    const { previous } = decodeEnvelope(completed, filePath);
    if (previous === null) data("active journal padding has no prior record", { filePath });
    return { offset, record: previous };
  }
  return { offset, record: decodeEnvelope(bytes, filePath).record };
}

export async function initialiseActiveJournal(paths, options) {
  const filePath = activeJournalPath(paths);
  try {
    return await readActiveJournal(paths, options.root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await publishAtomic(filePath,
      encodeActiveJournalRecord({ activeJournalVersion: 1, state: "idle" }), options);
  } catch (error) {
    if (error.code !== EXIT.CONFLICT) throw error;
  }
  return readActiveJournal(paths, options.root);
}

export async function readActiveJournal(paths, root, openFile) {
  const filePath = activeJournalPath(paths);
  return withRegularNoFollow(filePath, root, constants.O_RDONLY,
    async (handle, stat) => (await readCurrent(handle, stat.size, filePath)).record, openFile);
}

async function appendAll(handle, bytes) {
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(bytes, written, bytes.length - written);
    if (result.bytesWritten === 0) data("active journal append made no progress", {});
    written += result.bytesWritten;
  }
}

async function appendTransition(paths, options, next, expected) {
  const filePath = activeJournalPath(paths);
  return withRegularNoFollow(filePath, options.root,
    constants.O_RDWR | constants.O_APPEND, async (handle, stat) => {
      const current = await readCurrent(handle, stat.size, filePath);
      if (!expected(current.record)) {
        throw new AccError(EXIT.CONFLICT, "active journal transition conflicts",
          { current: current.record, next });
      }
      const remainder = stat.size % ACTIVE_JOURNAL_RECORD_BYTES;
      if (remainder !== 0) {
        const padding = Buffer.alloc(ACTIVE_JOURNAL_RECORD_BYTES - remainder, 0x20);
        if (padding.length < POINTER_BYTES) {
          padding[padding.length - 1] = 0;
        } else {
          padding[padding.length - POINTER_BYTES] = 0;
          let distance = BigInt(Math.floor(stat.size / ACTIVE_JOURNAL_RECORD_BYTES)
            - (current.offset / ACTIVE_JOURNAL_RECORD_BYTES));
          for (let index = padding.length - 1; index > padding.length - POINTER_BYTES;
            index -= 1) {
            padding[index] = Number(distance & 0xffn);
            distance >>= 8n;
          }
          if (distance !== 0n) data("active journal padding pointer is too large", { filePath });
        }
        await appendAll(handle, padding);
      }
      await appendAll(handle, encodeActiveJournalRecord(next, current.record));
      await handle.sync();
      return next;
    }, options.openFile);
}

export function activateJournal(paths, options, entry) {
  const next = { activeJournalVersion: 1, state: "open",
    transactionId: entry.transactionId, firstSequence: entry.firstSequence };
  return appendTransition(paths, options, next, current => current.state === "idle");
}

export function idleJournal(paths, options, transactionId) {
  return appendTransition(paths, options, { activeJournalVersion: 1, state: "idle" },
    current => current.state === "open" && current.transactionId === transactionId);
}
