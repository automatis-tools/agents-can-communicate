import path from "node:path";

import { AccError, EXIT, assertPortableId } from "@agents-can-communicate/protocol";

const AREAS = ["protocol", "events", "state", "locks", "quarantine", "ephemeral"];

/**
 * @typedef {{ root: string, protocol: string, events: string, state: string,
 *   locks: string, quarantine: string, ephemeral: string }} RuntimePaths
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
  for (const workspaceRoot of workspaceRoots) {
    const relative = path.relative(workspaceRoot, root);
    if (relative === "" || (!path.isAbsolute(relative) && !relative.startsWith(".."))) {
      throw new AccError(EXIT.USAGE, "runtime state must not live inside the workspace",
        { root, workspaceRoot });
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
