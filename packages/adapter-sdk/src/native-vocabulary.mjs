import { AccError, EXIT } from "@agents-can-communicate/protocol";

// The closed vocabulary behind native delivery - binding modes, activation
// kinds, captured platforms, reason codes - and the small validation
// primitives every native module shares. Kept apart so the contract, the
// activation plan, and later the hook helper all speak one dialect.

export const NATIVE_BINDING_MODES = Object.freeze([
  "livePush", "idleWake", "busyQueue", "replyRoute",
]);

export const NATIVE_ACTIVATION_KINDS = Object.freeze([
  "shell-bootstrap", "native-config", "native-service",
]);

export const NATIVE_PLATFORMS = Object.freeze([
  "darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64",
]);

// Every reason a client is not live, closed so doctor, hooks, and docs share
// one vocabulary and vendor strings never leak through it.
export const NATIVE_REASON_CODES = Object.freeze([
  "native_delivery_unsupported", "platform_not_captured", "version_unavailable",
  "prerelease_not_captured", "below_minimum_version", "known_bad_version",
  "feature_probe_failed", "probe_timeout", "probe_version_mismatch", "protocol_mismatch",
  "handshake_failed", "handshake_timeout", "handshake_version_mismatch",
  "session_generation_stale", "client_process_unknown", "unsupported_shell",
  // The transport works, but ACC cannot tell which workspace the session is in,
  // so it has no honest way to address it. Measured on Codex 0.152.1: native
  // delivery requires `--remote unix://`, and in that mode the hook payload and
  // the App Server's own thread record both report the daemon's directory
  // rather than the session's. Joining a session to whatever project the daemon
  // happened to start in is worse than not joining it at all.
  "workspace_identity_unavailable",
]);

export const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/;
export const CONTRACT_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const IDENTIFIER = /^[a-z][a-z0-9_-]*$/;
export const COMMAND_NAME = /^[a-z][a-z0-9_.-]*$/;
export const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
export const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
export const SHELL_SOURCE = /[;&|<>`\n\0]|\$\(/;
export const KNOWN_BAD_REASON = "known_bad_version";
export const PROBE_KEYS = ["supported", "clientVersion", "protocolContract", "executableFingerprint",
  "modes", "reasonCode"];
export const HANDSHAKE_KEYS = ["supported", "clientVersion", "protocolContract", "modes",
  "opaqueEndpointRef", "leaseUntil", "reasonCode"];

export function usage(message, details = {}) {
  throw new AccError(EXIT.USAGE, message, details);
}

export const isPlainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
export const isText = value => typeof value === "string" && value !== "";

export function closed(value, keys, label) {
  if (!isPlainObject(value)) usage(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) usage(`unknown ${label} field ${key}`, { key });
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) usage(`${label} requires ${key}`, { key });
  }
}

export function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

export function parseStableVersion(text) {
  const match = typeof text === "string" ? STABLE_VERSION.exec(text) : null;
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareStableVersions(left, right) {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  if (a === null || b === null) {
    usage("native version comparison needs two stable semantic versions", { left, right });
  }
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function assertModes(modes, label) {
  if (!Array.isArray(modes) || new Set(modes).size !== modes.length
    || modes.some(mode => !NATIVE_BINDING_MODES.includes(mode))) {
    usage(`${label} modes must be unique entries of ${NATIVE_BINDING_MODES.join(", ")}`);
  }
}

export function assertReasonCode(value, label) {
  if (value !== null && !NATIVE_REASON_CODES.includes(value)) {
    usage(`${label} reasonCode must be null or a closed native reason code`, { reasonCode: value });
  }
}
