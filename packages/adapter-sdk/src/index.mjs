// Capability contract, context projection, config ownership, and the binding
// that survives between two ephemeral hook processes.
export { CAPABILITY_SHAPE, assertCapabilities, defineAdapter } from "./capabilities.mjs";
export { EVENT_KINDS, NORMALIZED_EVENT_KEYS, normalizedEvent } from "./events.mjs";
export { assertRunner, bakeSkillCommand, defaultCli, defaultRunner, removeInstalledTree,
  runnerExists, writeHookShim }
  from "./hook-shim.mjs";
export { BEGIN, END, removeTomlBlock, renderBlock, stripBlock, tomlString, writeTomlBlock }
  from "./toml-block.mjs";
export { projectContext } from "./context-projector.mjs";
export { formatJsonAs, jsonStyleOf, mergeOwnedConfig, mergeOwnedEntries, ownedEntries, ownedKeys,
  removeOwnedConfig, removeOwnedEntries, writeForeignJson } from "./config-merge.mjs";
export { clearSessionBinding, listSessionBindings, loadSessionBinding,
  storeSessionBinding }
  from "./session-binding.mjs";
