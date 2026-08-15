import path from "node:path";

import { CommsError, EXIT } from "./errors.mjs";

export const MESSAGE_TYPES = Object.freeze([
  "status",
  "question",
  "contract_request",
  "contract_response",
  "blocker",
  "handoff",
  "broadcast",
]);
export const SEVERITIES = Object.freeze(["info", "action", "blocker"]);

function invalid(message, details = null) {
  throw new CommsError(message, EXIT.DATA, details);
}

function record(value, name, required, optional = []) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${name} must be an object`, { value });
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${name} has unknown field`, { field: key });
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) invalid(`${name} is missing required field`, { field: key });
  }
  return value;
}

function version(value) {
  if (value !== 1) invalid("unknown schema version", { value });
}

function string(value, name, { empty = false } = {}) {
  if (typeof value !== "string" || (!empty && value.length === 0)) {
    invalid(`${name} must be a string`, { value });
  }
  return value;
}

function oneOf(value, allowed, name) {
  if (!allowed.includes(value)) invalid(`invalid ${name}`, { value });
  return value;
}

function boolean(value, name) {
  if (typeof value !== "boolean") invalid(`${name} must be a boolean`, { value });
  return value;
}

function integer(value, name, minimum = Number.MIN_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    invalid(`${name} must be an integer`, { value });
  }
  return value;
}

function array(value, name, validate) {
  if (!Array.isArray(value)) invalid(`${name} must be an array`, { value });
  value.forEach((item, index) => validate(item, `${name}[${index}]`));
  return value;
}

function isoTimestamp(value, name) {
  string(value, name);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    invalid(`${name} must be a canonical UTC timestamp`, { value });
  }
  return value;
}

export function validateAgentId(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{1,31}$/.test(value)) {
    throw new CommsError("invalid agent id", EXIT.DATA, { value });
  }
  return value;
}

export function validateSha256(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    invalid("invalid SHA-256", { value });
  }
  return value;
}

export function validateGitSha(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    invalid("invalid Git SHA", { value });
  }
  return value;
}

export function validateRepoPath(value, name = "path") {
  string(value, name);
  if (
    value === "." || value === ".."
    || value.includes("\\")
    || path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || value.startsWith("../")
  ) {
    invalid(`${name} must be a normalized repository-relative path`, { value });
  }
  return value;
}

export function validateScope(value, name = "scope") {
  string(value, name);
  if (value.startsWith("contract:")) {
    if (!/^contract:[a-z0-9][a-z0-9._-]*$/.test(value)) invalid(`invalid ${name}`, { value });
    return value;
  }
  return validateRepoPath(value, name);
}

export function validateAttachment(value) {
  record(value, "attachment", ["path", "sha256", "size", "ephemeral"], ["commit"]);
  validateRepoPath(value.path, "attachment.path");
  validateSha256(value.sha256);
  integer(value.size, "attachment.size", 0);
  boolean(value.ephemeral, "attachment.ephemeral");
  if (value.ephemeral && !value.path.startsWith(".agents/artifacts/")) {
    invalid("ephemeral attachment must be inside .agents/artifacts", { path: value.path });
  }
  if (Object.hasOwn(value, "commit")) {
    validateGitSha(value.commit);
    if (value.ephemeral) invalid("ephemeral attachment cannot have a commit", { path: value.path });
  }
  return value;
}

export function validateProtocol(value) {
  record(value, "protocol", [
    "schema_version", "protocol_version", "checkout_id", "checkout_root", "initialized_at",
  ]);
  version(value.schema_version);
  if (value.protocol_version !== 1) invalid("unknown protocol version", { value: value.protocol_version });
  validateSha256(value.checkout_id);
  if (typeof value.checkout_root !== "string" || !path.isAbsolute(value.checkout_root)) {
    invalid("checkout_root must be absolute", { value: value.checkout_root });
  }
  isoTimestamp(value.initialized_at, "initialized_at");
  return value;
}

export function validateRegistry(value) {
  record(value, "registry", [
    "schema_version", "agent_id", "role", "task", "worktree", "branch", "head",
    "ownership", "status", "registered_at", "updated_at",
  ], ["client", "closed_at"]);
  version(value.schema_version);
  validateAgentId(value.agent_id);
  string(value.role, "role");
  string(value.task, "task");
  if (typeof value.worktree !== "string" || !path.isAbsolute(value.worktree)) {
    invalid("worktree must be absolute", { value: value.worktree });
  }
  string(value.branch, "branch");
  validateGitSha(value.head);
  array(value.ownership, "ownership", validateScope);
  oneOf(value.status, ["open", "closed"], "registry status");
  isoTimestamp(value.registered_at, "registered_at");
  isoTimestamp(value.updated_at, "updated_at");
  if (Object.hasOwn(value, "client")) {
    oneOf(value.client, ["codex", "claude-code", "cursor", "other"], "client");
  }
  if (Object.hasOwn(value, "closed_at")) isoTimestamp(value.closed_at, "closed_at");
  if (value.status === "closed" && !Object.hasOwn(value, "closed_at")) {
    invalid("closed registry requires closed_at");
  }
  return value;
}

export function validatePresence(value) {
  record(value, "presence", ["schema_version", "agent_id", "pid", "status", "heartbeat_at"]);
  version(value.schema_version);
  validateAgentId(value.agent_id);
  integer(value.pid, "pid", 1);
  oneOf(value.status, ["online", "offline"], "presence status");
  isoTimestamp(value.heartbeat_at, "heartbeat_at");
  return value;
}

export function validateMessage(value) {
  record(value, "message", [
    "schema_version", "id", "from", "to", "type", "severity", "subject", "body",
    "task", "reply_to", "requires_ack", "created_at", "sender_head", "attachments",
  ]);
  version(value.schema_version);
  string(value.id, "message.id");
  if (value.id.includes("/") || value.id.includes("\\")) invalid("invalid message id", { value: value.id });
  validateAgentId(value.from);
  validateAgentId(value.to);
  oneOf(value.type, MESSAGE_TYPES, "message type");
  oneOf(value.severity, SEVERITIES, "message severity");
  string(value.subject, "subject");
  string(value.body, "body", { empty: true });
  string(value.task, "task");
  if (value.reply_to !== null) string(value.reply_to, "reply_to");
  boolean(value.requires_ack, "requires_ack");
  isoTimestamp(value.created_at, "created_at");
  validateGitSha(value.sender_head);
  array(value.attachments, "attachments", validateAttachment);
  return value;
}

function validateReceipt(value, timestampField, name) {
  record(value, name, ["schema_version", "message_id", "recipient", timestampField]);
  version(value.schema_version);
  string(value.message_id, "message_id");
  validateAgentId(value.recipient);
  isoTimestamp(value[timestampField], timestampField);
  return value;
}

export function validateSeenReceipt(value) {
  return validateReceipt(value, "seen_at", "seen receipt");
}

export function validateAcknowledgement(value) {
  return validateReceipt(value, "acknowledged_at", "acknowledgement");
}

export function validateClaim(value) {
  record(value, "claim", [
    "schema_version", "agent_id", "task", "scope", "reason",
    "created_at", "updated_at", "expires_at",
  ]);
  version(value.schema_version);
  validateAgentId(value.agent_id);
  string(value.task, "task");
  validateScope(value.scope);
  string(value.reason, "reason");
  for (const field of ["created_at", "updated_at", "expires_at"]) isoTimestamp(value[field], field);
  return value;
}

function validateVerification(value) {
  record(value, "verification", ["command", "exitCode", "summary"]);
  string(value.command, "verification.command");
  integer(value.exitCode, "verification.exitCode", 0);
  string(value.summary, "verification.summary");
}

function validateContracts(value) {
  record(value, "contracts", ["added", "changed", "consumed"]);
  for (const field of ["added", "changed", "consumed"]) {
    array(value[field], `contracts.${field}`, item => string(item, `contracts.${field}`));
  }
}

export function validateHandoff(value) {
  record(value, "handoff", [
    "schema_version", "id", "from", "to", "task", "result", "branch", "commit", "base",
    "changed_paths", "verification", "contracts", "follow_up", "artifacts", "limitations",
    "uncommitted", "ready_to_merge", "state", "created_at",
  ]);
  version(value.schema_version);
  string(value.id, "handoff.id");
  validateAgentId(value.from);
  validateAgentId(value.to);
  for (const field of ["task", "result", "branch"]) string(value[field], field);
  boolean(value.uncommitted, "uncommitted");
  if (value.commit !== null) validateGitSha(value.commit);
  validateGitSha(value.base);
  if (!value.uncommitted && value.commit === null) invalid("committed handoff requires commit");
  if (value.uncommitted && value.commit !== null) invalid("uncommitted handoff cannot have commit");
  array(value.changed_paths, "changed_paths", validateRepoPath);
  array(value.verification, "verification", validateVerification);
  if (value.verification.length === 0) invalid("handoff requires verification evidence");
  const verificationFailed = value.verification.some(item => item.exitCode !== 0);
  validateContracts(value.contracts);
  array(value.follow_up, "follow_up", validateAgentId);
  array(value.artifacts, "artifacts", validateAttachment);
  array(value.limitations, "limitations", item => string(item, "limitation"));
  boolean(value.ready_to_merge, "ready_to_merge");
  oneOf(value.state, ["READY", "NOT_READY", "UNCOMMITTED"], "handoff state");
  const expectedState = value.uncommitted ? "UNCOMMITTED" : value.ready_to_merge ? "READY" : "NOT_READY";
  if (value.state !== expectedState || (value.uncommitted && value.ready_to_merge)
    || (!value.uncommitted && verificationFailed && value.ready_to_merge)) {
    invalid("handoff readiness contradicts state or verification");
  }
  isoTimestamp(value.created_at, "created_at");
  return value;
}

export function validateLock(value) {
  record(value, "lock", ["schema_version", "owner_agent", "pid", "acquired_at"]);
  version(value.schema_version);
  validateAgentId(value.owner_agent);
  integer(value.pid, "pid", 1);
  isoTimestamp(value.acquired_at, "acquired_at");
  return value;
}
