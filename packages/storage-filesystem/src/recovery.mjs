import path from "node:path";

import { AccError, EXIT, validateRecord } from "@agents-can-communicate/protocol";

import { listDirectoryEntries, listJsonFiles, readJsonIfPresent } from "./atomic-json.mjs";
import { readStoreIdentity } from "./identity.mjs";
import { readOpenJournals, rollForward } from "./journal.mjs";
import { assertEventBinding, assertStateBinding } from "./record-id.mjs";
import { storePaths } from "./store.mjs";
import { withWriterMutex } from "./writer-mutex.mjs";

/** @typedef {{ healthy: boolean, repaired: string[], blocked: string[],
 * corrupt: string[] }} RepairReport */

const report = ({ repaired = [], blocked = [], corrupt = [] }) => ({
  healthy: blocked.length === 0 && corrupt.length === 0,
  repaired: [...repaired].sort(),
  blocked: [...blocked].sort(),
  corrupt: [...corrupt].sort(),
});

async function inspect(root) {
  const paths = storePaths(root);
  const blocked = [];
  const corrupt = [];
  let pending = [];

  // Identity first. A store whose version or identity does not validate is
  // never mutated, so an operator repairing the wrong directory fails closed
  // instead of rewriting someone else's state.
  let identity = null;
  try {
    identity = await readStoreIdentity(paths);
  } catch (error) {
    blocked.push(path.join(root, "protocol.json"));
    return { paths, identity: null, pending, blocked, corrupt, reason: error.message };
  }
  if (identity === null) blocked.push(path.join(root, "protocol.json"));

  try {
    pending = await readOpenJournals(paths, root);
  } catch (error) {
    corrupt.push(paths.journal);
    return { paths, identity, pending: [], blocked, corrupt, reason: error.message };
  }

  for (const kind of (await listDirectoryEntries(paths.state, { root }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name)) {
    for (const filePath of await listJsonFiles(path.join(paths.state, kind), { root })) {
      try {
        const found = await readJsonIfPresent(filePath, root);
        const envelope = assertStateBinding(found.value, kind,
          path.basename(filePath, ".json"), filePath);
        validateRecord(envelope.kind, envelope.record);
      } catch {
        corrupt.push(filePath);
      }
    }
  }

  let expected = 1;
  for (const filePath of await listJsonFiles(paths.events, { root })) {
    try {
      const found = await readJsonIfPresent(filePath, root);
      const event = assertEventBinding(found.value, filePath);
      validateRecord("event", event);
      // A gap can only survive a completed roll-forward if a file was removed
      // by hand, so it is corruption rather than a pending publication.
      if (Number(event.sequence) !== expected && pending.length === 0) corrupt.push(filePath);
      expected = Number(event.sequence) + 1;
    } catch {
      corrupt.push(filePath);
    }
  }

  return { paths, identity, pending, blocked, corrupt, reason: null };
}

export async function diagnoseFilesystemStore({ root }) {
  const state = await inspect(root);
  return report({
    blocked: state.blocked,
    corrupt: state.corrupt,
    repaired: state.pending.map(entry => entry.transactionId),
  });
}

export async function repairFilesystemStore({ root, clock }) {
  const state = await inspect(root);
  if (state.blocked.length > 0 || state.corrupt.length > 0) {
    // Fail closed. Completing a journal on top of state we cannot even read
    // would turn an ambiguous store into a confidently wrong one.
    return report({ blocked: state.blocked, corrupt: state.corrupt });
  }
  if (state.pending.length === 0) return report({});

  const repaired = await withWriterMutex(state.paths, { root, tmpDir: state.paths.tmp, clock },
    async () => {
      const completed = [];
      for (const entry of await readOpenJournals(state.paths, root)) {
        await rollForward(state.paths, { root, tmpDir: state.paths.tmp, clock }, entry);
        completed.push(entry.transactionId);
      }
      return completed;
    });
  return report({ repaired });
}

export function assertRepairable(reportValue) {
  if (!reportValue.healthy) {
    throw new AccError(EXIT.DATA, "store state is ambiguous; repair is blocked", reportValue);
  }
  return reportValue;
}
