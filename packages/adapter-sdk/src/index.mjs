// Capability contract, context projection, config ownership, and the binding
// that survives between two ephemeral hook processes.
export { CAPABILITY_SHAPE, assertCapabilities, defineAdapter } from "./capabilities.mjs";
export { EVENT_KINDS, NORMALIZED_EVENT_KEYS, normalizedEvent } from "./events.mjs";
export { projectContext } from "./context-projector.mjs";
export { mergeOwnedConfig, ownedKeys, removeOwnedConfig } from "./config-merge.mjs";
export { clearSessionBinding, loadSessionBinding, storeSessionBinding }
  from "./session-binding.mjs";
