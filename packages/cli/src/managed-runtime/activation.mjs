import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertPortableId } from "@agents-can-communicate/protocol";
import { readSessionRecord } from "@agents-can-communicate/storage-filesystem";
import { listRuntimeHolds } from "./leases.mjs";
import { confirmedDead, defaultPidIsAlive, withManagerLock } from "./mutex.mjs";
import { canonicalManagerRoot, managedDirectory, readControl, readManagedJson, writeControl } from "./state.mjs";

// Both 0.3.1 and current MCP write this exact continuity record, without
// native client facts. A foreign harness id may look like an MCP key: require
// its canonical file and a validated matching MCP owner before exempting it.
async function isMcpContinuity(record, name, workspaceRoot, workspaceId) {
  if (record?.schemaVersion !== 1 || Object.keys(record).sort().join(",")
    !== "accSessionId,generation,harnessSessionId,schemaVersion") return false;
  try {
    const parts = record.harnessSessionId.split(":");
    if (parts.length !== 3 || parts[0] !== "mcp" || parts[2] !== workspaceId) return false;
    for (const id of [parts[1], parts[2], record.accSessionId, record.generation]) assertPortableId(id, "MCP continuity id");
    const expected = createHash("sha256").update(record.harnessSessionId).digest("hex").slice(0, 32) + ".json";
    if (name !== expected) return false;
    const owner = await readSessionRecord({ root: workspaceRoot, workspaceId, sessionId: record.accSessionId });
    return owner?.harness === "mcp" && owner.participantId === parts[1]
      && owner.workspaceId === workspaceId && owner.sessionId === record.accSessionId
      && owner.generation === record.generation;
  } catch { return false; } // Ambiguous or corrupt ownership remains a safety hold.
}

/** Native bindings outlive finish/TTL; MCP process lifetime is covered by its runtime lease. */
export async function listNativeHolds(root, { pidIsAlive = defaultPidIsAlive } = {}) {
  const workspaces = path.join(path.dirname(await canonicalManagerRoot(root)), "workspaces");
  if (!await managedDirectory(workspaces)) return [];
  const holds = [];
  for (const entry of await readdir(workspaces, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      if (entry.isSymbolicLink()) holds.push({ kind: "native", reason: "unknown_workspace" });
      continue;
    }
    const bindings = path.join(workspaces, entry.name, "bindings");
    if (!await managedDirectory(bindings)) continue;
    for (const name of await readdir(bindings)) {
      if (!name.endsWith(".json")) continue;
      const record = await readManagedJson(path.join(bindings, name)).catch(() => null);
      if (record === undefined) continue; // Concurrent lifecycle removal, before fencing.
      if (await isMcpContinuity(record, name, path.dirname(bindings), entry.name)) continue;
      const pid = record?.schemaVersion === 1 && Number.isSafeInteger(record.clientPid)
        && record.clientPid > 0 ? record.clientPid : null;
      if (pid !== null && await confirmedDead(pid, pidIsAlive)) continue;
      holds.push({ kind: "native", pid, reason: pid === null ? "unknown_client_pid" : "client_running" });
    }
  }
  return holds;
}

/** Activation calls this under the admission mutex; diagnostics are a snapshot.
 * The updater may ignore its own leases, never a native client's lifetime.
 * Project only process facts: leases and bindings carry private owner tokens.
 */
export async function listActivationBlockers(root, { pidIsAlive = defaultPidIsAlive, ignorePid = null } = {}) {
  const leases = (await listRuntimeHolds(root, { pidIsAlive })).filter(lease => lease.pid !== ignorePid);
  const native = await listNativeHolds(root, { pidIsAlive });
  const holds = [...leases.map(({ pid, kind }) => ({ pid, kind, nativeBindings: 0 })),
    ...native.map(hold => ({ ...hold, nativeBindings: hold.reason === "unknown_workspace" ? 0 : 1 }))];
  const byPid = new Map(), unidentified = [];
  for (const hold of holds) {
    const pid = hold.pid ?? null;
    const nativeBindings = hold.nativeBindings;
    if (pid === null) {
      unidentified.push({ pid, kinds: [hold.kind], reason: hold.reason, nativeBindings });
      continue;
    }
    const blocker = byPid.get(pid) ?? { pid, kinds: [], reason: "process_running", nativeBindings: 0 };
    if (!blocker.kinds.includes(hold.kind)) blocker.kinds.push(hold.kind);
    blocker.nativeBindings += nativeBindings;
    byPid.set(pid, blocker);
  }
  return [...byPid.values()].sort((a, b) => a.pid - b.pid)
    .map(blocker => ({ ...blocker, kinds: blocker.kinds.sort() })).concat(unidentified);
}

export function activationBlockerNotice(version, blockers) {
  if (!blockers.length) return `ACC ${version} is ready; no active or unidentified processes are blocking activation.`;
  const details = blockers.slice(0, 10).map(blocker => {
    const facts = [blocker.kinds.map(safeText).join(", ")];
    if (blocker.nativeBindings) facts.push(`${blocker.nativeBindings} native binding${blocker.nativeBindings === 1 ? "" : "s"}`);
    if (blocker.pid === null) facts.push(blocker.reason.replaceAll("_", " "));
    return `${blocker.pid === null ? "unidentified process" : `PID ${blocker.pid}`} (${facts.join("; ")})`;
  });
  return `ACC ${version} is ready; waiting for ${blockers.length} active or unidentified process(es): `
    + details.join("; ") + (blockers.length > 10 ? `; and ${blockers.length - 10} more` : "") + ".";
}

async function prepareCandidate(control, root, env) {
  const file = path.join(control.pending.root, "node_modules", "@agents-can-communicate", "cli",
    "src", "managed-runtime", "refresh.mjs");
  const { prepareRefresh } = await import(pathToFileURL(file).href);
  return prepareRefresh({ control, root, env, callerProtocol: 2 });
}
// JSON parser diagnostics may quote private config bytes. Keep the cause and
// known artifact paths, never the offending input or terminal control bytes.
const safeText = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 1000);
function safeFailure(error) {
  const message = typeof error === "string" ? error : "integration refresh failed";
  if (/(?:valid|parse|parsing) JSON|JSON (?:input|at position)|Unexpected token|Expected.*(?:property|comma|colon)/i.test(message)) return "configuration is not valid JSON";
  return safeText(message);
}
const recipe = c => JSON.stringify([c.active, c.pending, c.home, c.targets, c.auto, c.pin]);

/** Detection is outside the fence; every integration write and commit stays inside it. */
export async function activatePending(root, { prepare = prepareCandidate, env = process.env,
  pidIsAlive = defaultPidIsAlive, ignorePid = null, beforeActivation = null } = {}) {
  root = await canonicalManagerRoot(root);
  const before = await readControl(root);
  if (!before?.pending) return { activated: false, reason: "no_pending_update" };
  const apply = await prepare(before, root, env);
  return withManagerLock(root, async () => {
    const current = await readControl(root);
    if (!current || recipe(current) !== recipe(before)) return { activated: false, reason: "state_changed" };
    if (beforeActivation) await beforeActivation(current);
    const blockers = await listActivationBlockers(root, { pidIsAlive, ignorePid });
    if (blockers.length) {
      const notice = activationBlockerNotice(current.pending.version, blockers);
      await writeControl(root, { ...current, notice });
      return { activated: false, reason: "processes_active", holds: blockers.length, blockers, notice };
    }
    const activating = { ...current, phase: "activating", notice: "Finishing integration refresh." };
    await writeControl(root, activating);
    let result;
    try {
      result = await apply(); // Never release the fence with a mutating promise still running.
      if (!result || !Array.isArray(result.failed) || result.failed.length) {
        throw new Error("integration refresh is incomplete");
      }
    } catch (error) {
      const notice = "Integration refresh is incomplete; run acc update to recover.";
      await writeControl(root, { ...activating, notice });
      const installation = result && Array.isArray(result.failed) ? { ...result,
        failed: result.failed.map(failure => ({ ...failure, adapterId: safeText(failure.adapterId), error: safeFailure(failure.error),
          paths: (failure.paths ?? []).map(file => safeText(file)) })) } : undefined;
      return { activated: false, reason: "refresh_failed", notice, error: safeFailure(error.message),
        ...(installation ? { installation } : {}) };
    }
    await writeControl(root, { ...activating, active: current.pending, pending: null,
      phase: "ready", notice: `ACC ${current.pending.version} is active.` });
    return { activated: true, version: current.pending.version, installation: result };
  });
}
