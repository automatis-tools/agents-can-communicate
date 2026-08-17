// Composition root: discovery, runtime locations, and the CLI surface.
export { main } from "./main.mjs";
export { COMMANDS, parseArgs } from "./args.mjs";
// Exported so a test can hold every adapter to where it plans to write and
// which binary decides it runs at all.
export { ALL_ADAPTERS, clientContext } from "./install-command.mjs";
export { discoverWorkspace } from "./workspace-discovery.mjs";
export { createGitProbe, hermeticEnv } from "./git-probe.mjs";
export { platformDataHome, runtimePaths } from "./runtime-paths.mjs";
export { platformPaths } from "./platform-paths.mjs";
