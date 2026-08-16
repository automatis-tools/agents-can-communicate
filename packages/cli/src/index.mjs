// Composition root: discovery, runtime locations, and the CLI surface.
export { main } from "./main.mjs";
export { COMMANDS, parseArgs } from "./args.mjs";
export { discoverWorkspace } from "./workspace-discovery.mjs";
export { createGitProbe, hermeticEnv } from "./git-probe.mjs";
export { platformDataHome, runtimePaths } from "./runtime-paths.mjs";
