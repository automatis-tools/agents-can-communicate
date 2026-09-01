import { AccError, EXIT } from "./errors.mjs";
import { assertPortableId } from "./ids.mjs";

export const CONFIG_SCHEMA_VERSION = 1;

// One name, so discovery is a lookup rather than a search. A tool that accepts
// four spellings has four ways to load the wrong file.
export const CONFIG_FILENAME = "acc.workspace.json";

// Project config carries identity and shared policy. Presence, messages,
// claims, receipts and tokens belong to the runtime directory; a repository is
// the wrong place for them, and a config carrying them is either a mistake or
// an attempt to hand a peer state it would otherwise have to earn.
export const RUNTIME_KEYS = Object.freeze(["sessions", "participants", "messages",
  "claims", "receipts", "intents", "events", "deliveryBindings", "tokens", "credentials"]);

const KNOWN_KEYS = Object.freeze(["schemaVersion", "workspaceId", "displayName",
  "roots", "policy", "requiredAdapters", "extensions"]);

const CLAIM_MODES = Object.freeze(["advisory", "guarded"]);

// The same default the context projector uses. Zero silently disables
// coordination context; a very large one spends the model's window on a roster.
const DEFAULT_CONTEXT_BUDGET_BYTES = 6_000;
const MAX_CONTEXT_BUDGET_BYTES = 64_000;

const data = (message, details) => {
  throw new AccError(EXIT.DATA, message, details);
};

/**
 * What a workspace policy is when nobody wrote one.
 *
 * Config is optional, so every value it can carry needs an answer without it.
 * `workspaceId` is the exception and is null: identity comes from Git or the
 * directory in that case, and inventing one here would give two checkouts of
 * the same project two identities that both look deliberate.
 */
export function defaultProjectConfig() {
  return Object.freeze({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    workspaceId: null,
    displayName: null,
    roots: Object.freeze(["."]),
    policy: Object.freeze({ claimMode: "advisory",
      contextBudgetBytes: DEFAULT_CONTEXT_BUDGET_BYTES }),
    requiredAdapters: Object.freeze([]),
    extensions: Object.freeze({}),
  });
}

function assertRoot(root, source) {
  if (typeof root !== "string" || root === "") {
    data("each workspace root must be a non-empty string", { source, root });
  }
  // Absolute is one machine's layout committed to a shared repository.
  if (root.startsWith("/") || /^[A-Za-z]:[\\/]/.test(root)) {
    data("a workspace root must be relative to the config", { source, root });
  }
  // Checked on the segments rather than the string: `packages/../../escape`
  // leaves the workspace while containing no leading `..`.
  const segments = root.split(/[\\/]/);
  let depth = 0;
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    depth += segment === ".." ? -1 : 1;
    if (depth < 0) data("a workspace root must not leave the workspace", { source, root });
  }
}

function assertPolicy(policy, source) {
  if (policy === undefined) return { claimMode: "advisory",
    contextBudgetBytes: DEFAULT_CONTEXT_BUDGET_BYTES };
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    data("policy must be an object", { source });
  }
  for (const key of Object.keys(policy)) {
    if (!["claimMode", "contextBudgetBytes"].includes(key)) {
      data(`unknown policy key: ${key}`, { source, key });
    }
  }
  const claimMode = policy.claimMode ?? "advisory";
  if (!CLAIM_MODES.includes(claimMode)) {
    data(`policy.claimMode must be one of ${CLAIM_MODES.join(", ")}`, { source, claimMode });
  }
  const contextBudgetBytes = policy.contextBudgetBytes ?? DEFAULT_CONTEXT_BUDGET_BYTES;
  if (!Number.isInteger(contextBudgetBytes) || contextBudgetBytes <= 0
    || contextBudgetBytes > MAX_CONTEXT_BUDGET_BYTES) {
    data(`policy.contextBudgetBytes must be an integer between 1 and ${
      MAX_CONTEXT_BUDGET_BYTES}`, { source, contextBudgetBytes });
  }
  return { claimMode, contextBudgetBytes };
}

/**
 * Validate a project config.
 *
 * Strict about unknown keys, with `extensions` as the one declared door for
 * anything else. A silently ignored key is how a team's policy stops applying
 * without anyone noticing - `clam_mode` reads like a typo to a human and like
 * nothing at all to a parser that shrugs.
 */
export function validateProjectConfig(config, { source = CONFIG_FILENAME } = {}) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    data("the workspace config must be an object", { source });
  }
  if (config.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    data("unknown workspace config schemaVersion",
      { source, schemaVersion: config.schemaVersion ?? null });
  }

  const runtime = RUNTIME_KEYS.filter(key => Object.hasOwn(config, key));
  if (runtime.length > 0) {
    data(`the workspace config must not carry runtime state: ${runtime.join(", ")}`,
      { source, keys: runtime });
  }
  const unknown = Object.keys(config).filter(key => !KNOWN_KEYS.includes(key));
  if (unknown.length > 0) {
    data(`unknown workspace config key: ${unknown.join(", ")}`, { source, keys: unknown });
  }

  assertPortableId(config.workspaceId, "workspace id");
  if (config.displayName !== undefined && typeof config.displayName !== "string") {
    data("displayName must be a string", { source });
  }

  const roots = config.roots ?? ["."];
  if (!Array.isArray(roots) || roots.length === 0) {
    data("roots must be a non-empty array", { source });
  }
  for (const root of roots) assertRoot(root, source);

  const requiredAdapters = config.requiredAdapters ?? [];
  if (!Array.isArray(requiredAdapters)) data("requiredAdapters must be an array", { source });
  for (const adapter of requiredAdapters) assertPortableId(adapter, "adapter id");

  if (config.extensions !== undefined && (config.extensions === null
    || typeof config.extensions !== "object" || Array.isArray(config.extensions))) {
    data("extensions must be an object", { source });
  }

  return Object.freeze({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    workspaceId: config.workspaceId,
    displayName: config.displayName ?? null,
    roots: Object.freeze([...roots]),
    policy: Object.freeze(assertPolicy(config.policy, source)),
    requiredAdapters: Object.freeze([...requiredAdapters]),
    extensions: Object.freeze({ ...(config.extensions ?? {}) }),
  });
}
