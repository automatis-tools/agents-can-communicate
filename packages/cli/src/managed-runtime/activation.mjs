import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertPortableId } from "@agents-can-communicate/protocol";
import { readSessionRecord } from "@agents-can-communicate/storage-filesystem";
import { listRuntimeHolds } from "./leases.mjs";
import { confirmedDead, defaultPidIsAlive, withManagerLock } from "./mutex.mjs";
import { reapPins } from "./pins.mjs";
import { reapStagingHolds } from "./staging.mjs";
import { canonicalManagerRoot, managedDirectory, readControl, readManagedJson, syncDirectory, writeControl } from "./state.mjs";

/** The staged generation states its own contract in its manifest, so the
 * manager never imports code from a generation it has not activated. */
export async function declaredStoreVersion(generationRoot) {
  const manifest = await readManagedJson(path.join(generationRoot, "package.json")).catch(() => null);
  return Number.isSafeInteger(manifest?.accStoreVersion) && manifest.accStoreVersion > 0
    ? manifest.accStoreVersion : null;
}

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
      holds.push({ kind: "native", pid, reason: pid === null ? "unknown_client_pid" : "client_running",
        storeVersion: Number.isSafeInteger(record?.storeVersion) ? record.storeVersion : null });
    }
  }
  return holds;
}

/** Unknown on either side cannot be compared, and an uncomparable contract
 * stays a hold. Equal contracts coexist by the store's own rule. */
export const blocksActivation = (hold, incomingStoreVersion) =>
  !Number.isSafeInteger(incomingStoreVersion) || !Number.isSafeInteger(hold.storeVersion)
    || hold.storeVersion !== incomingStoreVersion;

/** Activation calls this under the admission mutex; diagnostics are a snapshot.
 * The updater may ignore its own leases, never a native client's lifetime.
 * Project only process facts: leases and bindings carry private owner tokens.
 * A hold blocks only when its declared contract differs from the incoming
 * generation's, or when either side declares none.
 */
export async function listActivationBlockers(root, { pidIsAlive = defaultPidIsAlive,
  ignorePid = null, incomingStoreVersion = null } = {}) {
  const leases = (await listRuntimeHolds(root, { pidIsAlive })).filter(lease => lease.pid !== ignorePid);
  const native = await listNativeHolds(root, { pidIsAlive });
  const holds = [
    ...leases.map(({ pid, kind, runtime }) => ({ pid, kind, nativeBindings: 0,
      storeVersion: runtime?.storeVersion ?? null })),
    ...native.map(hold => ({ ...hold, nativeBindings: hold.reason === "unknown_workspace" ? 0 : 1,
      storeVersion: hold.storeVersion ?? null })),
  ];
  const byPid = new Map(), unidentified = [];
  for (const hold of holds) {
    const pid = hold.pid ?? null;
    const nativeBindings = hold.nativeBindings;
    if (pid === null) {
      unidentified.push({ pid, kinds: [hold.kind], reason: hold.reason, nativeBindings,
        storeVersion: hold.storeVersion });
      continue;
    }
    const blocker = byPid.get(pid) ?? { pid, kinds: [], reason: "process_running",
      nativeBindings: 0, storeVersion: hold.storeVersion };
    if (!blocker.kinds.includes(hold.kind)) blocker.kinds.push(hold.kind);
    blocker.nativeBindings += nativeBindings;
    // One process can publish several holds. Only an unbroken run of holds
    // declaring the same contract may keep it for the whole process; an
    // unknown contract, or one that differs from what has already
    // accumulated, collapses the process to uncomparable for good.
    if (!Number.isSafeInteger(hold.storeVersion) || hold.storeVersion !== blocker.storeVersion) {
      blocker.storeVersion = null;
    }
    byPid.set(pid, blocker);
  }
  return [...byPid.values()].sort((a, b) => a.pid - b.pid)
    .map(blocker => ({ ...blocker, kinds: blocker.kinds.sort() })).concat(unidentified)
    .filter(blocker => blocksActivation(blocker, incomingStoreVersion));
}

export function activationBlockerNotice(version, blockers) {
  if (!blockers.length) return `ACC ${version} is ready; no active or unidentified processes are blocking activation.`;
  const details = blockers.slice(0, 10).map(blocker => {
    const facts = [blocker.kinds.map(safeText).join(", ")];
    if (blocker.nativeBindings) facts.push(`${blocker.nativeBindings} native binding${blocker.nativeBindings === 1 ? "" : "s"}`);
    facts.push(Number.isSafeInteger(blocker.storeVersion)
      ? `store contract ${blocker.storeVersion}` : "contract unknown");
    if (blocker.pid === null) facts.push(blocker.reason.replaceAll("_", " "));
    return `${blocker.pid === null ? "unidentified process" : `PID ${blocker.pid}`} (${facts.join("; ")})`;
  });
  return `ACC ${version} is ready; waiting for ${blockers.length} active or unidentified process(es): `
    + details.join("; ") + (blockers.length > 10 ? `; and ${blockers.length - 10} more` : "") + ".";
}

/** A candidate reference that is simply absent (no pending update, no
 * explicit active override) is normal. One that is present but cannot be
 * resolved to a real filesystem path is unknown - possibly corrupt data -
 * and must postpone the whole pass rather than be silently ignored. Every
 * candidate is resolved the same way a `generations/<name>` entry is, so a
 * symlinked data home can never make a live reference look unrelated to the
 * directory it actually names.
 */
async function resolveCandidate(value) {
  if (value === null || value === undefined) return { ok: true, root: null };
  if (typeof value !== "string" || value === "") return { ok: false };
  try { return { ok: true, root: await canonicalManagerRoot(value) }; }
  catch { return { ok: false }; }
}

/** A generation is reclaimable only when nothing can still import from it:
 * not the active or pending control pointer, not a live runtime lease, not a
 * live session pin, and not a live staging hold for a generation still being
 * verified before publication. An unidentified holder - an unreadable lease,
 * a pin or staging hold that is missing, corrupt, or declares an
 * unresolvable root, or the absence of control.json itself - postpones the
 * whole pass rather than being assumed dead, matching the rule admission
 * already applies to its own bookkeeping.
 *
 * Takes its own manager lock, so a caller already holding one (activation)
 * must call this only after releasing it.
 */
export async function reclaimGenerations({ root, active = null, pidIsAlive = defaultPidIsAlive } = {}) {
  root = await canonicalManagerRoot(root);
  return withManagerLock(root, async () => {
    const generations = path.join(root, "generations");
    if (!await managedDirectory(generations)) return { removed: [] };
    const control = await readControl(root);
    // No control at all is exactly as unknown as a corrupt one - which
    // readControl already throws on, and every real caller of this function
    // treats that throw as reason to postpone. Match that here explicitly:
    // an absent control.json is not proof there is nothing to protect.
    if (control === null) return { removed: [] };
    const referenced = new Set();
    for (const candidate of [active, control.active.root, control.pending?.root]) {
      const resolved = await resolveCandidate(candidate);
      if (!resolved.ok) return { removed: [] };
      if (resolved.root) referenced.add(resolved.root);
    }
    let holds;
    try { holds = await listRuntimeHolds(root, { pidIsAlive }); }
    catch { return { removed: [] }; } // An unreadable lease is an unknown holder.
    for (const lease of holds) {
      const resolved = await resolveCandidate(lease.runtime?.root);
      if (!resolved.ok) return { removed: [] };
      if (resolved.root) referenced.add(resolved.root);
    }
    // A client that exits without a clean session end leaves its pin behind;
    // reap confirmed-dead ones before treating every remaining pin as live,
    // the same way admission already reaps confirmed-dead leases.
    await reapPins({ root, pidIsAlive });
    const pins = path.join(root, "pins");
    if (await managedDirectory(pins)) {
      for (const name of await readdir(pins)) {
        if (!name.endsWith(".json")) continue;
        const record = await readManagedJson(path.join(pins, name)).catch(() => null);
        if (record === undefined) continue; // Concurrent pin removal, not a holder.
        if (!record || record.schemaVersion !== 1 || typeof record.runtimeRoot !== "string"
          || record.runtimeRoot === "") return { removed: [] }; // Malformed pin: unknown holder.
        const resolved = await resolveCandidate(record.runtimeRoot);
        if (!resolved.ok) return { removed: [] };
        referenced.add(resolved.root);
      }
    }
    // Staging renames a fully-formed generation into place, then runs it as a
    // spawned process to verify it, before any control pointer, lease, or pin
    // can reference it. A live hold names exactly the generation that step
    // is building; a staging process that exited without publishing leaves
    // its hold behind, reaped the same way an abandoned pin is.
    await reapStagingHolds({ root, pidIsAlive });
    const staging = path.join(root, "staging");
    if (await managedDirectory(staging)) {
      for (const name of await readdir(staging)) {
        if (!name.endsWith(".json")) continue;
        const record = await readManagedJson(path.join(staging, name)).catch(() => null);
        if (record === undefined) continue; // Concurrent hold release, not a holder.
        if (!record || record.schemaVersion !== 1 || typeof record.generationRoot !== "string"
          || record.generationRoot === "") return { removed: [] }; // Malformed hold: unknown holder.
        const resolved = await resolveCandidate(record.generationRoot);
        if (!resolved.ok) return { removed: [] };
        referenced.add(resolved.root);
      }
    }
    const removed = [];
    for (const entry of await readdir(generations, { withFileTypes: true })) {
      // A dot-prefixed entry is always an in-flight staging temp (mkdtemp's
      // own naming), never a published generation. Its own creator cleans it
      // up; guessing whether it is still being written into is not this
      // function's job, and deleting one mid-write would corrupt that write.
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const directory = path.join(generations, entry.name);
      if (referenced.has(directory)) continue;
      await rm(directory, { recursive: true, force: true });
      removed.push(entry.name);
    }
    if (removed.length) await syncDirectory(generations);
    return { removed };
  }, { pidIsAlive });
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
  let activatedRoot = null;
  const outcome = await withManagerLock(root, async () => {
    const current = await readControl(root);
    if (!current || recipe(current) !== recipe(before)) return { activated: false, reason: "state_changed" };
    if (beforeActivation) await beforeActivation(current);
    const blockers = await listActivationBlockers(root, { pidIsAlive, ignorePid,
      incomingStoreVersion: current.pending.storeVersion });
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
    activatedRoot = current.pending.root;
    return { activated: true, version: current.pending.version, installation: result };
  });
  // Reclaim only after the fence has released and the new pointer is durable:
  // reclaimGenerations takes its own manager lock, so calling it while still
  // inside this one would deadlock, and a reclaim failure here must never
  // turn an already-completed activation into a reported failure - it can
  // always run again on the next activation.
  if (outcome.activated) {
    try { await reclaimGenerations({ root, active: activatedRoot, pidIsAlive }); }
    catch { /* Best effort; never fails an activation that already succeeded. */ }
  }
  return outcome;
}
