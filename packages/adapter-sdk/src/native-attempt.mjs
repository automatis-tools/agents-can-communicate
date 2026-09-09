import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { NATIVE_REASON_CODES, TIMESTAMP } from "./native-vocabulary.mjs";

// Optional diagnostic metadata beside the hook-owner file, never an event
// history or injected context. Copy only closed values: vendor errors, prompts,
// endpoints and extra properties must not survive persistence or doctor reads.
export function nativeAttemptFrom(value) {
  if (!value || typeof value.at !== "string" || !TIMESTAMP.test(value.at)
    || !Number.isFinite(Date.parse(value.at))
    || !["sessionStart", "beforeTurn"].includes(value.event)
    || !["active", "off", "degraded", "unsupported"].includes(value.state)
    || !(value.reasonCode === null || NATIVE_REASON_CODES.includes(value.reasonCode))
    || !["off", "actionable", "all"].includes(value.policy)
    || !["bootstrap-environment", "installation-record"].includes(value.policySource)
    || !["enabled", "off", "missing", "invalid", "unavailable"].includes(value.policyStatus)
    || !["identified", "unknown"].includes(value.clientProcess)) return null;
  return { at: value.at, event: value.event, state: value.state, reasonCode: value.reasonCode,
    policy: value.policy, policySource: value.policySource, policyStatus: value.policyStatus,
    clientProcess: value.clientProcess };
}

const keyFor = harnessSessionId => createHash("sha256").update(String(harnessSessionId))
  .digest("hex").slice(0, 32);
const fileFor = (runtimeDir, harnessSessionId) =>
  path.join(runtimeDir, "native-attempts", `${keyFor(harnessSessionId)}.json`);
export async function loadNativeAttempt({ runtimeDir, harnessSessionId, accSessionId, generation }) {
  try {
    const record = JSON.parse(await readFile(fileFor(runtimeDir, harnessSessionId), "utf8"));
    return record.schemaVersion === 1 && record.accSessionId === accSessionId
      && record.generation === generation ? nativeAttemptFrom(record.attempt) : null;
  } catch { return null; }
}

// Isolate filesystem requests as well as JS waiting: even a stuck fs request
// must not keep the vendor's short-lived hook process alive after its output.
// The unreferenced worker owns its mutex through any late I/O continuation.
async function writeDiagnostic(operation, input) {
  const deadlineAt = Math.min(input.deadlineAt ?? Infinity, Date.now() + 250);
  if (Date.now() >= deadlineAt) return false;
  let worker;
  let timer;
  try {
    worker = new Worker(new URL("./native-attempt-writer.mjs", import.meta.url), {
      workerData: { operation, input: { runtimeDir: input.runtimeDir,
        harnessSessionId: input.harnessSessionId, accSessionId: input.accSessionId,
        generation: input.generation, nativeAttempt: nativeAttemptFrom(input.nativeAttempt), deadlineAt } },
    });
    const result = new Promise(resolve => {
      worker.once("message", value => resolve(value === true));
      worker.once("error", () => resolve(false));
      worker.once("exit", () => resolve(false));
      timer = setTimeout(() => resolve(false), Math.max(0, deadlineAt - Date.now()));
    });
    worker.unref();
    return await result;
  } catch { return false; }
  finally { clearTimeout(timer); }
}

export const storeNativeAttempt = input => writeDiagnostic("store", input);
export const clearNativeAttempt = input => writeDiagnostic("clear", input);
