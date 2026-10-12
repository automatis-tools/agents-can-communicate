// Every client adapter by id, loaded only by the command or hook that serves
// it. Importing all six cost every `acc version`, indicator read and hook their
// module graphs (#270), so this module imports none of them until asked.
const LOADERS = Object.freeze({
  // Registered like any other client. Its hook commands carry an extra
  // argument - the event name - because this client's payload has none.
  antigravity: () => import("@agents-can-communicate/adapter-antigravity")
    .then(module => module.createAntigravityAdapter()),
  claude_code: () => import("@agents-can-communicate/adapter-claude-code")
    .then(module => module.createClaudeCodeAdapter()),
  codex: () => import("@agents-can-communicate/adapter-codex")
    .then(module => module.createCodexAdapter()),
  gemini_cli: () => import("@agents-can-communicate/adapter-gemini-cli")
    .then(module => module.createGeminiCliAdapter()),
  grok: () => import("@agents-can-communicate/adapter-grok")
    .then(module => module.createGrokAdapter()),
  kimi: () => import("@agents-can-communicate/adapter-kimi")
    .then(module => module.createKimiAdapter()),
});

export const ADAPTER_IDS = Object.freeze(Object.keys(LOADERS));

/** The adapter for one id, or null for an id no adapter has. */
export async function loadAdapter(adapterId) {
  return Object.hasOwn(LOADERS, adapterId) ? LOADERS[adapterId]() : null;
}

/** The adapters for these ids, keyed by id; unknown ids are left out. */
export async function loadAdapters(adapterIds) {
  const known = [...new Set(adapterIds)].filter(adapterId => Object.hasOwn(LOADERS, adapterId));
  return Object.fromEntries(await Promise.all(known.map(async adapterId =>
    [adapterId, await LOADERS[adapterId]()])));
}
