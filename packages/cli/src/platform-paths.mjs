import path from "node:path";

import { AccError, EXIT } from "@agents-can-communicate/protocol";

// Resolution is a pure function of platform and environment, so the Windows and
// Linux answers are testable from a machine that is neither. Reading
// process.platform inside would mean two of the three branches are only ever
// exercised by whoever happens to run them.
const AREAS = Object.freeze(["data", "config", "cache"]);

const OVERRIDE = Object.freeze({
  data: "ACC_DATA_HOME",
  config: "ACC_CONFIG_HOME",
  cache: "ACC_CACHE_HOME",
});

const XDG = Object.freeze({
  data: "XDG_DATA_HOME",
  config: "XDG_CONFIG_HOME",
  cache: "XDG_CACHE_HOME",
});

// An exported-but-empty variable is the normal shape of "unset" in a shell
// script. Treating it as a path puts runtime state at the filesystem root.
const set = value => typeof value === "string" && value.length > 0;

const usage = (message, details) => {
  throw new AccError(EXIT.USAGE, message, details);
};

function windowsPaths(env) {
  if (!set(env.APPDATA)) {
    usage("cannot resolve the Windows application data directory");
  }
  return {
    data: env.APPDATA,
    config: env.APPDATA,
    // Roaming is the honest fallback: a cache that roams is wasteful, not wrong.
    cache: set(env.LOCALAPPDATA) ? env.LOCALAPPDATA : env.APPDATA,
  };
}

function requireHome(env) {
  if (!set(env.HOME)) usage("cannot resolve the user home directory");
  return env;
}

function macosPaths(env) {
  const support = path.join(env.HOME, "Library", "Application Support");
  // XDG variables are deliberately ignored here. They are common on a machine
  // that also runs Linux tooling, and letting one relocate macOS state would
  // move a user's sessions the day they install something unrelated.
  return { data: support, config: support,
    cache: path.join(env.HOME, "Library", "Caches") };
}

function xdgPaths(env) {
  const fallback = { data: path.join(env.HOME, ".local", "share"),
    config: path.join(env.HOME, ".config"), cache: path.join(env.HOME, ".cache") };
  return Object.fromEntries(AREAS.map(area =>
    [area, set(env[XDG[area]]) ? env[XDG[area]] : fallback[area]]));
}

/**
 * Where ACC keeps state, configuration, and cache on this platform.
 *
 * None of it is ever inside a workspace. A checkout can be deleted, cloned, or
 * synced to another machine without carrying presence, locks, or messages with
 * it - and "just put it in a dotfile next to the project" is the exact
 * regression this exists to prevent, which is why passing `workspaceRoots`
 * makes it an error rather than a convention.
 */
export function platformPaths({ platform = process.platform, env = process.env,
  workspaceRoots = [] } = {}) {
  // Windows paths are not absolute to a posix `path`, so the check has to use
  // the same flavour the platform does.
  const flavour = platform === "win32" ? path.win32 : path.posix;

  const overridden = Object.fromEntries(AREAS
    .filter(area => set(env[OVERRIDE[area]]))
    .map(area => [area, env[OVERRIDE[area]]]));

  // The platform is only consulted for what was not named outright, so a fully
  // overridden environment never has to satisfy that platform's own
  // prerequisites - which is what makes a test fixture for one platform
  // runnable on another.
  const missing = AREAS.filter(area => overridden[area] === undefined);
  const base = missing.length === 0 ? {}
    : platform === "win32" ? windowsPaths(env)
      : platform === "darwin" ? macosPaths(requireHome(env))
        : xdgPaths(requireHome(env));

  const resolved = Object.fromEntries(AREAS.map(area =>
    [area, overridden[area] ?? base[area]]));

  for (const [area, location] of Object.entries(resolved)) {
    if (!flavour.isAbsolute(location)) {
      usage(`the ${area} location must be an absolute path`, { area, location });
    }
    for (const root of workspaceRoots) {
      const relative = flavour.relative(root, location);
      if (relative === ""
        || (!flavour.isAbsolute(relative) && !relative.startsWith(".."))) {
        usage(`${area} state must not live inside the workspace`, { area, location, root });
      }
    }
  }
  return Object.freeze(resolved);
}
