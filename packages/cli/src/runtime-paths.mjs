import path from "node:path";

import { AccError, EXIT, assertPortableId } from "@agents-can-communicate/protocol";

const AREAS = ["protocol", "events", "state", "locks", "ephemeral"];

/**
 * @typedef {{ root: string, protocol: string, events: string, state: string,
 *   locks: string, ephemeral: string }} RuntimePaths
 */

/**
 * Runtime state lives under the platform's user-data directory, never inside
 * the workspace. A checkout can be deleted, cloned, or synced to another
 * machine without carrying presence, locks, or messages with it.
 */
export function runtimePaths({ dataHome, workspaceId, workspaceRoots = [] }) {
  if (typeof dataHome !== "string" || !path.isAbsolute(dataHome)) {
    throw new AccError(EXIT.USAGE, "the data home must be an absolute path", { dataHome });
  }
  assertPortableId(workspaceId, "workspace id");
  const root = path.join(dataHome, "acc", "workspaces", workspaceId);
  // Enforced here rather than only asserted in a test, because "just put it in
  // .agents next to the project" is the exact regression this design exists to
  // prevent, and it would otherwise look like it works.
  //
  // The message names both paths and what to do, because the case a person
  // actually meets is not the one this was written for. Running `acc` in a home
  // directory makes that directory the workspace - it is no checkout, so
  // discovery falls back to where you are - and the platform's own state
  // directory is inside a home by definition. So `acc status` in `~` answered
  // "runtime state must not live inside the workspace", which reads as a
  // misconfiguration and tells the reader nothing they can act on.
  for (const workspaceRoot of workspaceRoots) {
    const relative = path.relative(workspaceRoot, root);
    if (relative === "" || (!path.isAbsolute(relative) && !relative.startsWith(".."))) {
      throw new AccError(EXIT.USAGE,
        // The data home rather than the workspace's own directory inside it:
        // that is the one a reader can move, and the one the remedy names.
        `${workspaceRoot} holds ACC's own state at ${path.join(dataHome, "acc")}, `
        + "so it cannot be a workspace. Run acc inside a project, or point "
        + "ACC_DATA_HOME outside this directory.",
        { root, dataHome, workspaceRoot });
    }
  }
  return Object.freeze(Object.fromEntries([["root", root],
    // `ephemeral` holds presence and Intent for workspaces that have not
    // materialised durable state yet, so it is deliberately a sibling of the
    // event log rather than a corner of it.
    ...AREAS.map(area => [area, path.join(root, area)])]));
}

export function platformDataHome({ platform = process.platform, env = process.env } = {}) {
  if (typeof env.ACC_DATA_HOME === "string" && env.ACC_DATA_HOME.length > 0) {
    return env.ACC_DATA_HOME;
  }
  if (platform === "win32") {
    if (typeof env.APPDATA === "string" && env.APPDATA.length > 0) return env.APPDATA;
    throw new AccError(EXIT.USAGE, "cannot resolve the Windows application data directory");
  }
  if (typeof env.XDG_DATA_HOME === "string" && env.XDG_DATA_HOME.length > 0
    && platform !== "darwin") {
    return env.XDG_DATA_HOME;
  }
  if (typeof env.HOME !== "string" || env.HOME.length === 0) {
    throw new AccError(EXIT.USAGE, "cannot resolve the user home directory");
  }
  return platform === "darwin"
    ? path.join(env.HOME, "Library", "Application Support")
    : path.join(env.HOME, ".local", "share");
}
