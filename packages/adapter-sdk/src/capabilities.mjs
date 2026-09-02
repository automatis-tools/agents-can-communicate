import { AccError, EXIT, assertPortableId } from "@agents-can-communicate/protocol";

import { CAPABILITY_SHAPE, freezeCapabilities, validateCertification }
  from "./certification.mjs";

// The capability surface, documented in docs/ADAPTER_AUTHORING.md and measured
// per client in docs/CAPABILITIES.md. False is the default for every
// entry: an adapter earns a true value by implementing the method that backs it
// and by proving it in the conformance suite. Optimistic defaults are how a
// tool ends up claiming protection it cannot deliver.
export { CAPABILITY_SHAPE } from "./certification.mjs";

// Each true capability names the method that has to exist for it to be true.
const BACKING_METHOD = Object.freeze({
  "lifecycle.sessionStart": "startSession",
  "lifecycle.sessionResume": "resumeSession",
  "lifecycle.sessionEnd": "endSession",
  // A timer-driven event from the client, distinct from delivery.nextTurn: it
  // keeps presence fresh while the session is idle, which turn-driven hooks
  // cannot do.
  "lifecycle.heartbeat": "heartbeat",
  "lifecycle.childSessions": "mapChildSession",
  "context.startupInjection": "renderContext",
  "context.beforeTurnInjection": "renderContext",
  "context.safePointInjection": "renderContext",
  "guards.beforeRead": "guardRead",
  "guards.beforeWrite": "guardWrite",
  "guards.beforeShell": "guardShell",
  "delivery.nextTurn": "renderContextResult",
  "delivery.livePush": "offerMessage",
  "delivery.replyRoute": "routeReply",
});

const BASE_METHODS = Object.freeze(["detect", "install", "uninstall", "doctor",
  "normalizeHook", "renderContext"]);

function usage(message, details = {}) {
  throw new AccError(EXIT.USAGE, message, details);
}

export function assertCapabilities(declared = {}, implementation = {}, certification) {
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
        const client = implementation.client?.certificationName
          ?? implementation.client?.command;
        const proven = certification?.evidence.some(item => item.result === "pass"
          && item.capability === `${group}.${name}` && item.client === client);
        if (!proven) {
          usage(`capability ${group}.${name} requires passing evidence in certification`,
            { group, name, client });
        }
      }
      resolved[group][name] = value;
    }
    Object.freeze(resolved[group]);
  }
  return freezeCapabilities(resolved);
}

export function defineAdapter(manifest) {
  if (typeof manifest?.id !== "string") usage("an adapter must declare an id");
  assertPortableId(manifest.id, "adapter id");
  if (typeof manifest.displayName !== "string" || manifest.displayName.trim() === "") {
    usage("an adapter must declare a displayName", { id: manifest.id });
  }
  // Detection spawns this to decide whether the client is on the machine.
  // Left undeclared it used to fall back to the adapter id, so `claude_code`
  // and `gemini_cli` probed binaries that do not exist and were reported absent
  // on every machine - `acc install` silently skipped half its clients.
  const command = manifest.client?.command;
  if (typeof command !== "string" || command.trim() === "") {
    usage("an adapter must declare client.command, the binary its client installs",
      { id: manifest.id });
  }
  for (const method of BASE_METHODS) {
    if (typeof manifest[method] !== "function") {
      usage(`an adapter must implement ${method}()`, { id: manifest.id, method });
    }
  }
  const certification = validateCertification(manifest.certification);
  const known = new Set(Object.entries(CAPABILITY_SHAPE)
    .flatMap(([group, names]) => names.map(name => `${group}.${name}`)));
  for (const item of certification.evidence) {
    if (!known.has(item.capability)) {
      usage(`unknown certified capability: ${item.capability}`,
        { capability: item.capability });
    }
    const client = manifest.client.certificationName ?? manifest.client.command;
    if (item.client !== client) {
      usage(`certification evidence client ${item.client} does not match ${client}`,
        { evidenceClient: item.client, client });
    }
  }
  return Object.freeze({
    ...manifest,
    certification,
    capabilities: assertCapabilities(manifest.capabilities, manifest, certification),
  });
}
