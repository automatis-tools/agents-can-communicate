import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { AccError, EXIT } from "@agents-can-communicate/protocol";

const SCHEMA_VERSION = 1;

// Harness session ids are foreign input of unknown shape. Hashing them makes
// the filename safe by construction rather than by sanitising, so no id can
// select which file is written.
const fileFor = (runtimeDir, harnessSessionId) => path.join(runtimeDir, "bindings",
  `${createHash("sha256").update(String(harnessSessionId)).digest("hex").slice(0, 32)}.json`);

/**
 * Hook executables are ephemeral: the process that attaches is gone by the time
 * the next hook fires. The binding is what lets a later hook heartbeat and
 * detach the exact generation instead of opening a second session.
 *
 * It lives in the runtime directory, never the project, and carries identity
 * plus the exact client facts observed at attach time - no prompt, transcript,
 * or harness state.
 */
const isPid = value => Number.isInteger(value) && value > 0;

export async function storeSessionBinding({ runtimeDir, harnessSessionId, accSessionId,
  generation, clientVersion, platform, clientPid }) {
  const file = fileFor(runtimeDir, harnessSessionId);
  await mkdir(path.dirname(file), { recursive: true });
  const record = { schemaVersion: SCHEMA_VERSION, harnessSessionId, accSessionId, generation };
  if (typeof clientVersion === "string" && clientVersion !== "") record.clientVersion = clientVersion;
  if (typeof platform === "string" && platform !== "") record.platform = platform;
  // The vendor process this session runs in, resolved once at SessionStart.
  // A native endpoint is matched against it, so a binding without one can
  // still heartbeat and deliver at the next turn but cannot go live until a
  // fresh start resolves the process again.
  if (clientPid !== undefined && clientPid !== null) {
    if (!isPid(clientPid)) {
      throw new AccError(EXIT.USAGE, "session binding clientPid must be a positive integer",
        { clientPid });
    }
    record.clientPid = clientPid;
  }
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  // Replace rather than append: re-attaching supersedes the old generation, and
  // two live bindings for one harness session would be worse than none.
  await rename(temporary, file);
}

export async function loadSessionBinding({ runtimeDir, harnessSessionId }) {
  const file = fileFor(runtimeDir, harnessSessionId);
  let source;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  let record;
  try {
    record = JSON.parse(source);
  } catch (error) {
    // Returning null here would make the hook silently open a second session
    // and orphan the first. Failing closed is the honest outcome.
    throw new AccError(EXIT.DATA, "session binding is not valid JSON",
      { file, cause: error.message });
  }
  if (record?.schemaVersion !== SCHEMA_VERSION) {
    throw new AccError(EXIT.DATA, "unknown session binding schemaVersion",
      { file, schemaVersion: record?.schemaVersion });
  }
  const binding = { accSessionId: record.accSessionId, generation: record.generation };
  if (typeof record.clientVersion === "string") binding.clientVersion = record.clientVersion;
  if (typeof record.platform === "string") binding.platform = record.platform;
  if (isPid(record.clientPid)) binding.clientPid = record.clientPid;
  return binding;
}

export async function clearSessionBinding({ runtimeDir, harnessSessionId }) {
  await rm(fileFor(runtimeDir, harnessSessionId), { force: true });
}

/**
 * Every binding in this workspace, whole.
 *
 * `loadSessionBinding` answers "which session is *this* harness session", which
 * needs the harness id up front. The CLI has the opposite problem: an agent runs
 * `acc work` from a shell that was never told any id, so the question is which
 * of the live bindings is the one that spawned it.
 *
 * A file that cannot be read is skipped rather than fatal - the caller is trying
 * to identify itself among several, and one unreadable neighbour should not stop
 * it recognising its own.
 */
export async function listSessionBindings({ runtimeDir }) {
  const dir = path.join(runtimeDir, "bindings");
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const bindings = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = await readFile(path.join(dir, name), "utf8")
      .then(JSON.parse).catch(() => null);
    if (record?.schemaVersion !== SCHEMA_VERSION) continue;
    bindings.push({ harnessSessionId: record.harnessSessionId,
      accSessionId: record.accSessionId, generation: record.generation,
      ...(typeof record.clientVersion === "string"
        ? { clientVersion: record.clientVersion } : {}),
      ...(typeof record.platform === "string" ? { platform: record.platform } : {}),
      ...(isPid(record.clientPid) ? { clientPid: record.clientPid } : {}) });
  }
  return bindings;
}
