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
const TRIPLE = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/;

/** A client version as the triple that orders it. A prerelease is ordered by
 * its release triple: 1.3.0-rc.1 is judged as 1.3.0, because a prerelease of a
 * version ACC has already observed is not an older client. Anything unreadable
 * - a probe that failed, "unknown", a vendor string - returns null.
 */
function versionOrder(text) {
  const match = typeof text === "string" && text.toLowerCase() !== "unknown"
    ? TRIPLE.exec(text) : null;
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersionOrder(left, right) {
  if (left === null || right === null) return left === right ? 0 : left === null ? -1 : 1;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}
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

/**
 * What a client is certified for, judged against the exact version and
 * platform it reports.
 *
 * A version's own captures decide, capability by capability, including a
 * capture that failed. An adapter may also declare a certification floor per
 * platform: a stable version at or above it, with no capture of its own for a
 * capability, is judged by the floor version's evidence for that capability.
 * Versions below the floor, prereleases and other platforms stay uncertified.
 */
/**
 * Why a capability is on or off for one client, so a refusal can name the
 * evidence that refused it instead of the version that asked.
 *
 * A capture says where a behaviour was observed, not which single release may
 * use it. Clients ship almost daily, so evidence applies forward from the
 * version that recorded it until a later capture changes that capability, and
 * across platforms until one of them records something of its own. A version
 * that cannot be read is judged by the newest evidence: a hook that runs has
 * already proven the integration is installed.
 *
 * `reason` is one of `undeclared` (the adapter does not claim it), `unobserved`
 * (nobody has captured it), `older-than-evidence` (this client predates the
 * first capture, whose version is returned) or `recorded-failure` (a capture at
 * the returned version recorded the loss).
 */
export function capabilityEvidence(adapter, { clientVersion, platform } = {}, capability) {
  const [group, name] = capability.split(".");
  if (adapter.capabilities?.[group]?.[name] !== true) {
    return { granted: false, reason: "undeclared", version: null };
  }
  const client = adapter.client?.certificationName ?? adapter.client?.command;
  const named = (adapter.certification?.evidence ?? [])
    .filter(item => item.client === client && item.capability === capability);
  if (named.length === 0) return { granted: false, reason: "unobserved", version: null };
  const asked = versionOrder(clientVersion);
  const reachable = asked === null ? named
    : named.filter(item => compareVersionOrder(versionOrder(item.version), asked) <= 0);
  // Version first, platform second: a loss recorded on one platform at 1.3.0
  // says nothing about that platform at 1.2.3, where the only evidence in
  // reach is another platform's passing capture.
  const own = reachable.filter(item => item.platform === platform);
  const usable = own.length > 0 ? own : reachable;
  if (usable.length === 0) {
    const first = named.reduce((earliest, item) =>
      compareVersionOrder(versionOrder(item.version), versionOrder(earliest.version)) < 0
        ? item : earliest);
    return { granted: false, reason: "older-than-evidence", version: first.version };
  }
  const newest = usable.reduce((best, item) =>
    compareVersionOrder(versionOrder(item.version), versionOrder(best.version)) > 0 ? item : best);
  const deciding = versionOrder(newest.version);
  // Two platforms can disagree at the deciding version when neither is the
  // platform in hand. Withholding a body costs a trip to acc inbox; a false
  // "delivered" loses the message, so a recorded loss wins the tie.
  const granted = usable
    .filter(item => compareVersionOrder(versionOrder(item.version), deciding) === 0)
    .every(item => item.result === "pass");
  return { granted, reason: granted ? null : "recorded-failure", version: newest.version };
}

export function effectiveCapabilities(adapter, facts = {}) {
  const resolved = falseCapabilities();
  for (const [group, names] of Object.entries(CAPABILITY_SHAPE)) {
    for (const name of names) {
      resolved[group][name] = capabilityEvidence(adapter, facts, `${group}.${name}`).granted;
    }
  }
  return freezeCapabilities(resolved);
}

export function freezeCapabilities(capabilities) {
  for (const group of Object.keys(CAPABILITY_SHAPE)) Object.freeze(capabilities[group]);
  return Object.freeze(capabilities);
}
