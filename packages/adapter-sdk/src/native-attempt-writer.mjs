import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

import { assertPortableId } from "@agents-can-communicate/protocol";
import { withWriterMutex } from "@agents-can-communicate/storage-filesystem";
import { loadNativeAttempt, nativeAttemptFrom } from "./native-attempt.mjs";

const keyFor = harnessSessionId => createHash("sha256").update(String(harnessSessionId))
  .digest("hex").slice(0, 32);
const fileFor = (runtimeDir, harnessSessionId) =>
  path.join(runtimeDir, "native-attempts", `${keyFor(harnessSessionId)}.json`);
const checkDeadline = deadline => {
  if (Date.now() >= deadline) throw new Error("native diagnostic deadline expired");
};

// The caller stops waiting after 250 ms at most. An in-flight filesystem call
// may complete later, so retain this SEPARATE mutex until its continuation is
// finished. Unique staging names also isolate cleanup after stale-lock recovery.
// No diagnostic operation can touch the authoritative hook-owner file.
async function boundedWrite(input, operation) {
  const deadline = input.deadlineAt;
  try {
    checkDeadline(deadline);
    await withWriterMutex({ locks: path.join(input.runtimeDir, "native-attempt-locks",
      keyFor(input.harnessSessionId)) }, { root: input.runtimeDir,
      clock: { now: () => new Date().toISOString() }, deadlineAt: deadline },
    () => operation(deadline));
    return true;
  } catch { return false; }
}

async function storeNativeAttempt(input) {
  return boundedWrite(input, async deadline => {
    const { runtimeDir, harnessSessionId, accSessionId, generation } = input;
    assertPortableId(accSessionId, "native diagnostic session id");
    assertPortableId(generation, "native diagnostic generation");
    const attempt = nativeAttemptFrom(input.nativeAttempt);
    if (attempt === null) return;
    const file = fileFor(runtimeDir, harnessSessionId);
    const temporary = `${file}.${randomUUID()}.tmp`;
    checkDeadline(deadline);
    await mkdir(path.dirname(file), { recursive: true });
    try {
      checkDeadline(deadline);
      await writeFile(temporary, JSON.stringify({ schemaVersion: 1, accSessionId, generation,
        attempt }) + "\n", "utf8");
      checkDeadline(deadline);
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  });
}

async function clearNativeAttempt(input) {
  return boundedWrite(input, async deadline => {
    if (await loadNativeAttempt(input) === null) return;
    checkDeadline(deadline);
    await rm(fileFor(input.runtimeDir, input.harnessSessionId), { force: true });
  });
}

const operation = workerData.operation === "clear" ? clearNativeAttempt : storeNativeAttempt;
parentPort.postMessage(await operation(workerData.input));
