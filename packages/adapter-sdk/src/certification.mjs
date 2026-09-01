import path from "node:path";

import { AccError, EXIT } from "@agents-can-communicate/protocol";

export const CAPABILITY_SHAPE = Object.freeze({
  lifecycle: ["sessionStart", "sessionResume", "sessionEnd", "heartbeat", "childSessions"],
  context: ["startupInjection", "beforeTurnInjection", "safePointInjection"],
  guards: ["beforeRead", "beforeWrite", "beforeShell"],
  delivery: ["nextTurn", "livePush", "replyRoute"],
});

const REQUIRED_TEXT = Object.freeze(["client", "version", "platform", "observedAt",
  "capability", "fixture", "idleBehavior", "busyBehavior", "authorityLevel"]);
const RESULTS = new Set(["pass", "fail"]);

function usage(message, details = {}) {
  throw new AccError(EXIT.USAGE, message, details);
}

function assertText(entry, key, index) {
  if (typeof entry[key] !== "string" || entry[key].trim() === "") {
    usage(`certification evidence ${index} must declare ${key}`, { index, key });
  }
}

function validateFixture(value, index) {
  if (path.isAbsolute(value) || value.includes("\\") || value.split("/").includes("..")
    || !value.startsWith("fixtures/") || !value.endsWith(".json")) {
    usage(`certification evidence ${index} fixture must be package-local captured JSON`,
      { index, fixture: value });
  }
}

export function validateCertification(manifest) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    usage("an adapter must declare certification evidence");
  }
  if (!Array.isArray(manifest.evidence)) {
    usage("certification.evidence must be an array");
  }
  const evidence = manifest.evidence.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      usage(`certification evidence ${index} must be an object`, { index });
    }
    for (const key of REQUIRED_TEXT) assertText(entry, key, index);
    validateFixture(entry.fixture, index);
    if (!RESULTS.has(entry.result)) {
      usage(`certification evidence ${index} result must be pass or fail`,
        { index, result: entry.result });
    }
    if (!Array.isArray(entry.limitations)
      || entry.limitations.some(item => typeof item !== "string" || item.trim() === "")) {
      usage(`certification evidence ${index} limitations must be an array of text`, { index });
    }
    return Object.freeze({ ...entry, limitations: Object.freeze([...entry.limitations]) });
  });
  return Object.freeze({ ...manifest, evidence: Object.freeze(evidence) });
}

function falseCapabilities() {
  return Object.fromEntries(Object.entries(CAPABILITY_SHAPE).map(([group, names]) => [group,
    Object.fromEntries(names.map(name => [name, false]))]));
}

export function effectiveCapabilities(adapter, { clientVersion, platform } = {}) {
  const resolved = falseCapabilities();
  if (typeof clientVersion !== "string" || clientVersion === ""
    || typeof platform !== "string" || platform === "") return freezeCapabilities(resolved);
  const client = adapter.client?.certificationName ?? adapter.client?.command;
  const passing = new Set((adapter.certification?.evidence ?? [])
    .filter(item => item.result === "pass" && item.client === client
      && item.version === clientVersion && item.platform === platform)
    .map(item => item.capability));
  for (const [group, names] of Object.entries(CAPABILITY_SHAPE)) {
    for (const name of names) {
      resolved[group][name] = adapter.capabilities?.[group]?.[name] === true
        && passing.has(`${group}.${name}`);
    }
  }
  return freezeCapabilities(resolved);
}

export function freezeCapabilities(capabilities) {
  for (const group of Object.keys(CAPABILITY_SHAPE)) Object.freeze(capabilities[group]);
  return Object.freeze(capabilities);
}
