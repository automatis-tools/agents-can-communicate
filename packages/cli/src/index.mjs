// Composition root: discovery, runtime locations, and the CLI surface.
export { discoverWorkspace } from "./workspace-discovery.mjs";
export { createGitProbe, hermeticEnv } from "./git-probe.mjs";
export { platformDataHome, runtimePaths } from "./runtime-paths.mjs";
