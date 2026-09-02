import path from "node:path";

import { AccError, EXIT } from "@agents-can-communicate/protocol";

export const CAPABILITY_SHAPE = Object.freeze({
  lifecycle: Object.freeze(["sessionStart", "sessionResume", "sessionEnd", "heartbeat",
    "childSessions"]),
  context: Object.freeze(["startupInjection", "beforeTurnInjection", "safePointInjection"]),
  guards: Object.freeze(["beforeRead", "beforeWrite", "beforeShell"]),
  delivery: Object.freeze(["nextTurn", "livePush", "replyRoute"]),
});

const REQUIRED_TEXT = Object.freeze(["client", "version", "platform", "observedAt",
  "capability", "fixture", "provenance", "provenanceId", "idleBehavior", "busyBehavior",
  "authorityLevel"]);
const MANIFEST_KEYS = new Set(["evidence"]);
const EVIDENCE_KEYS = new Set([...REQUIRED_TEXT, "limitations", "result"]);
const RESULTS = new Set(["pass", "fail"]);
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const PLATFORM = /^(?:darwin|linux|win32)-(?:arm64|x64)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function usage(message, details = {}) {
  throw new AccError(EXIT.USAGE, message, details);
}

function assertText(entry, key, index) {
  if (typeof entry[key] !== "string" || entry[key].trim() === ""
    || entry[key] !== entry[key].trim()) {
    usage(`certification evidence ${index} must declare ${key}`, { index, key });
  }
}

function validatePackageJson(value, index, key) {
  if (path.isAbsolute(value) || value.includes("\\") || value.split("/").includes("..")
    || !value.startsWith("fixtures/") || !value.endsWith(".json")) {
    usage(`certification evidence ${index} ${key} must be package-local JSON`,
      { index, [key]: value });
  }
}

function validateObservedAt(value, index) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) {
    usage(`certification evidence ${index} observedAt must be an exact ISO date or timestamp`,
      { index, observedAt: value });
  }
  const validDate = DATE.test(value)
    && parsed.toISOString().slice(0, 10) === value;
  const validTimestamp = TIMESTAMP.test(value)
    && [parsed.toISOString(), parsed.toISOString().replace(".000Z", "Z")].includes(value);
  if (!validDate && !validTimestamp) {
    usage(`certification evidence ${index} observedAt must be an exact ISO date or timestamp`,
      { index, observedAt: value });
  }
}

function rejectUnknownKeys(value, known, label, index = null) {
  const unknown = Object.keys(value).find(key => !known.has(key));
  if (unknown !== undefined) {
    usage(`unknown ${label} field ${unknown}`,
      index === null ? { key: unknown } : { index, key: unknown });
  }
}

export function validateCertification(manifest) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    usage("an adapter must declare certification evidence");
  }
  rejectUnknownKeys(manifest, MANIFEST_KEYS, "certification");
  if (!Array.isArray(manifest.evidence)) {
    usage("certification.evidence must be an array");
  }
  const evidence = manifest.evidence.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      usage(`certification evidence ${index} must be an object`, { index });
    }
    rejectUnknownKeys(entry, EVIDENCE_KEYS, "certification evidence", index);
    for (const key of REQUIRED_TEXT) assertText(entry, key, index);
    validatePackageJson(entry.fixture, index, "fixture");
    validatePackageJson(entry.provenance, index, "provenance");
    if (!VERSION.test(entry.version) || entry.version.toLowerCase() === "unknown") {
      usage(`certification evidence ${index} version must be an exact client version`,
        { index, version: entry.version });
    }
    if (!PLATFORM.test(entry.platform) || entry.platform.toLowerCase() === "unknown") {
      usage(`certification evidence ${index} platform must be an exact supported platform`,
        { index, platform: entry.platform });
    }
    validateObservedAt(entry.observedAt, index);
    if (!RESULTS.has(entry.result)) {
      usage(`certification evidence ${index} result must be pass or fail`,
        { index, result: entry.result });
    }
    if (!Array.isArray(entry.limitations)
      || entry.limitations.some(item => typeof item !== "string" || item.trim() === "")) {
      usage(`certification evidence ${index} limitations must be an array of text`, { index });
    }
    return Object.freeze({
      client: entry.client,
      version: entry.version,
      platform: entry.platform,
      observedAt: entry.observedAt,
      capability: entry.capability,
      fixture: entry.fixture,
      provenance: entry.provenance,
      provenanceId: entry.provenanceId,
      idleBehavior: entry.idleBehavior,
      busyBehavior: entry.busyBehavior,
      authorityLevel: entry.authorityLevel,
      limitations: Object.freeze([...entry.limitations]),
      result: entry.result,
    });
  });
  const tuples = new Set();
  for (const [index, entry] of evidence.entries()) {
    const tuple = JSON.stringify([entry.client, entry.version, entry.platform,
      entry.capability]);
    if (tuples.has(tuple)) {
      usage(`duplicate certification tuple at evidence ${index}`,
        { index, client: entry.client, version: entry.version,
          platform: entry.platform, capability: entry.capability });
    }
    tuples.add(tuple);
  }
  return Object.freeze({ evidence: Object.freeze(evidence) });
}

function falseCapabilities() {
  return Object.fromEntries(Object.entries(CAPABILITY_SHAPE).map(([group, names]) => [group,
    Object.fromEntries(names.map(name => [name, false]))]));
}

export function effectiveCapabilities(adapter, { clientVersion, platform } = {}) {
  const resolved = falseCapabilities();
  if (typeof clientVersion !== "string" || !VERSION.test(clientVersion)
    || clientVersion.toLowerCase() === "unknown"
    || typeof platform !== "string" || !PLATFORM.test(platform)
    || platform.toLowerCase() === "unknown") return freezeCapabilities(resolved);
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
