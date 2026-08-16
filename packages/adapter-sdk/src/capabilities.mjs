import { AccError, EXIT, assertPortableId } from "@agents-can-communicate/protocol";

// The capability surface from docs/ADAPTERS.md. False is the default for every
// entry: an adapter earns a true value by implementing the method that backs it
// and by proving it in the conformance suite. Optimistic defaults are how a
// tool ends up claiming protection it cannot deliver.
export const CAPABILITY_SHAPE = Object.freeze({
  lifecycle: ["sessionStart", "sessionResume", "sessionEnd", "childSessions"],
  context: ["startupInjection", "beforeTurnInjection", "safePointInjection"],
  guards: ["beforeRead", "beforeWrite", "beforeShell"],
  delivery: ["polling", "activeNotification", "wakeDormantSession"],
  execution: ["launch", "resume", "terminate"],
});

// Each true capability names the method that has to exist for it to be true.
const BACKING_METHOD = Object.freeze({
  "lifecycle.sessionStart": "startSession",
  "lifecycle.sessionResume": "resumeSession",
  "lifecycle.sessionEnd": "endSession",
  "lifecycle.childSessions": "mapChildSession",
  "context.startupInjection": "renderContext",
  "context.beforeTurnInjection": "renderContext",
  "context.safePointInjection": "renderContext",
  "guards.beforeRead": "guardRead",
  "guards.beforeWrite": "guardWrite",
  "guards.beforeShell": "guardShell",
  "delivery.polling": "poll",
  "delivery.activeNotification": "notify",
  "delivery.wakeDormantSession": "wake",
  "execution.launch": "launch",
  "execution.resume": "resumeProcess",
  "execution.terminate": "terminate",
});

const BASE_METHODS = Object.freeze(["detect", "install", "uninstall", "doctor",
  "normalizeHook", "renderContext"]);

function usage(message, details = {}) {
  throw new AccError(EXIT.USAGE, message, details);
}

export function assertCapabilities(declared = {}, implementation = {}) {
  const resolved = {};
  for (const [group, names] of Object.entries(CAPABILITY_SHAPE)) {
    resolved[group] = Object.fromEntries(names.map(name => [name, false]));
  }
  for (const [group, values] of Object.entries(declared)) {
    if (!Object.hasOwn(CAPABILITY_SHAPE, group)) {
      usage(`unknown capability group: ${group}`, { group });
    }
    for (const [name, value] of Object.entries(values ?? {})) {
      if (!CAPABILITY_SHAPE[group].includes(name)) {
        usage(`unknown capability: ${group}.${name}`, { group, name });
      }
      if (typeof value !== "boolean") {
        usage(`capability ${group}.${name} must be a boolean`, { group, name, value });
      }
      if (value === true) {
        const method = BACKING_METHOD[`${group}.${name}`];
        if (typeof implementation[method] !== "function") {
          usage(`capability ${group}.${name} requires ${method}()`, { group, name, method });
        }
      }
      resolved[group][name] = value;
    }
    Object.freeze(resolved[group]);
  }
  for (const group of Object.keys(CAPABILITY_SHAPE)) Object.freeze(resolved[group]);
  return Object.freeze(resolved);
}

export function defineAdapter(manifest) {
  if (typeof manifest?.id !== "string") usage("an adapter must declare an id");
  assertPortableId(manifest.id, "adapter id");
  if (typeof manifest.displayName !== "string" || manifest.displayName.trim() === "") {
    usage("an adapter must declare a displayName", { id: manifest.id });
  }
  for (const method of BASE_METHODS) {
    if (typeof manifest[method] !== "function") {
      usage(`an adapter must implement ${method}()`, { id: manifest.id, method });
    }
  }
  return Object.freeze({
    ...manifest,
    capabilities: assertCapabilities(manifest.capabilities, manifest),
  });
}
