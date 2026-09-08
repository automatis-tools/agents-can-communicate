import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { listRuntimeHolds } from "./leases.mjs";
import { confirmedDead, defaultPidIsAlive, withManagerLock } from "./mutex.mjs";
import { canonicalManagerRoot, managedDirectory, readControl, readManagedJson, writeControl } from "./state.mjs";

/** Bindings outlive finish/presence TTL; only OS death removes their safety hold. */
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
      const pid = record?.schemaVersion === 1 && Number.isSafeInteger(record.clientPid)
        && record.clientPid > 0 ? record.clientPid : null;
      if (pid !== null && await confirmedDead(pid, pidIsAlive)) continue;
      holds.push({ kind: "native", pid, reason: pid === null ? "unknown_client_pid" : "client_running" });
    }
  }
  return holds;
}

async function prepareCandidate(control, root, env) {
  const file = path.join(control.pending.root, "node_modules", "@agents-can-communicate", "cli",
    "src", "managed-runtime", "refresh.mjs");
  const { prepareRefresh } = await import(pathToFileURL(file).href);
  return prepareRefresh({ control, root, env });
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
  pidIsAlive = defaultPidIsAlive, ignorePid = null } = {}) {
  root = await canonicalManagerRoot(root);
  const before = await readControl(root);
  if (!before?.pending) return { activated: false, reason: "no_pending_update" };
  const apply = await prepare(before, root, env);
  return withManagerLock(root, async () => {
    const current = await readControl(root);
    if (!current || recipe(current) !== recipe(before)) return { activated: false, reason: "state_changed" };
    const holds = (await listRuntimeHolds(root, { pidIsAlive })).filter(lease => lease.pid !== ignorePid);
    holds.push(...await listNativeHolds(root, { pidIsAlive }));
    if (holds.length) {
      const notice = `ACC ${current.pending.version} is ready; waiting for ${holds.length} active or unidentified process(es).`;
      await writeControl(root, { ...current, notice });
      return { activated: false, reason: "processes_active", holds: holds.length, notice };
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
