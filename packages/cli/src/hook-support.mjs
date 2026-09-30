// What a hook needs from this package, without the rest of it. A hook starts a
// process on every turn, and the package index loads the whole command line and
// the installer with it: modules a hook never runs, about a millisecond each on
// windows-latest.
export { resolveHookWorkspace } from "./hook-workspace.mjs";
export { createGitProbe } from "./git-probe.mjs";
export { platformDataHome, runtimePaths } from "./runtime-paths.mjs";
export { clearPin, hookEntrypointFor, resolvePinnedGeneration, writePin }
  from "./managed-runtime/pins.mjs";
