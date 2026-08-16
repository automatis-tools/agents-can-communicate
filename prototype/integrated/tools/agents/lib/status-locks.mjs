import path from "node:path";

import { listDirectoryEntries } from "./atomic-json.mjs";
import { inspectRepairMutex, repairStaleRepairMutex } from "./repair-mutex.mjs";

async function watcherMutexIds(context) {
  const entries = await listDirectoryEntries(context.paths.locks,
    { root: context.paths.root });
  return entries.filter(entry => /^watcher-.+\.lock$/.test(entry.name))
    .map(entry => entry.name.slice(8, -5)).sort();
}
export async function collectMutexStatus(context) {
  const watcher = { live: [], young: [], stale: [], corrupt: [] };
  for (const agentId of await watcherMutexIds(context)) {
    let inspected;
    try { inspected = await inspectRepairMutex(context, "watcher", agentId); }
    catch { inspected = { state: "corrupt", owner: null,
      path: path.join(context.paths.locks, `watcher-${agentId}.lock`) }; }
    if (inspected !== null) watcher[inspected.state].push(inspected);
  }
  return { doctor: await inspectRepairMutex(context, "doctor"), watcher };
}
export function mutexIssues(locks, makeIssue) {
  const issues = [];
  if (locks.doctor !== null) issues.push(makeIssue(
    `DOCTOR_MUTEX_${locks.doctor.state.toUpperCase()}`, locks.doctor.path,
    `doctor mutex is ${locks.doctor.state}`, locks.doctor.state === "stale" ? "warning" : "error"));
  for (const state of ["live", "young", "stale", "corrupt"])
    for (const inspected of locks.watcher[state]) issues.push(makeIssue(
      `WATCHER_MUTEX_${state.toUpperCase()}`, inspected.path,
      `watcher mutex is ${state}`, state === "stale" ? "warning" : "error"));
  return issues;
}
export async function repairStaleWatcherMutexes(context, locks) {
  const repairs = [];
  for (const inspected of locks.watcher.stale) {
    const agentId = path.basename(inspected.path).slice(8, -5);
    if (await repairStaleRepairMutex(context, "watcher", agentId)) repairs.push({
      action: "repair_stale_watcher_mutex", path: inspected.path });
  }
  return repairs;
}
