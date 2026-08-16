import { AccError, EXIT } from "./errors.mjs";
import { flag, id, invalid, listOf, nullable, oneOf, plainObject, positiveInteger,
  resourceUri, sequence, text, timestamp } from "./fields.mjs";

export const SCHEMA_VERSION = 1;

const line = text();
const prose = text({ max: 4000, multiline: true });
const summary = text({ max: 280 });
const artifactKind = oneOf("file", "git", "url", "report", "image", "data");

/** @typedef {{ sequence: string, eventId: string, workspaceId: string,
 * actorSessionId: string, type: string, occurredAt: string, payload: object }} AccEvent */
/** @typedef {{ cursor: string, events: AccEvent[] }} EventPage */
/** @typedef {{ kind: string, priority: number, sourceId: string, summary: string }} AttentionItem */
/** @typedef {{ workspace: object, participants: object[], sessions: object[],
 * intents: object[], workstreams: object[], tasks: object[], claims: object[] }} WorkspaceSnapshot */

// Field names stay mappable to the A2A Agent Card, Task, Message, and Artifact
// concepts (spec section 11) without importing any A2A transport.
const artifactRef = (value, field) => {
  plainObject(value, field);
  const known = new Set(["kind", "uri", "description", "sha256"]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) invalid(`${field}.${key}`, "is not a known artifact field", value[key]);
  }
  artifactKind(value.kind, `${field}.kind`);
  resourceUri(value.uri, `${field}.uri`);
  line(value.description, `${field}.description`);
  if (value.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(value.sha256)) {
    invalid(`${field}.sha256`, "must be a lowercase SHA-256 digest", value.sha256);
  }
  return value;
};

const RECORDS = Object.freeze({
  workspace: { workspaceId: id, displayName: line, source: oneOf("config", "git", "directory"),
    roots: listOf(line), createdAt: timestamp },

  participant: { participantId: id, workspaceId: id, displayName: line,
    kind: oneOf("agent", "human"), createdAt: timestamp },

  session: { sessionId: id, participantId: id, workspaceId: id, generation: id,
    harness: line, state: oneOf("open", "closed"), parentSessionId: nullable(id),
    heartbeatCadenceMs: positiveInteger, startedAt: timestamp, heartbeatAt: timestamp },

  intent: { sessionId: id, workspaceId: id, summary,
    mode: oneOf("observe", "explore", "edit", "review", "coordinate", "wait"),
    resourceHints: listOf(resourceUri), workstreamId: nullable(id),
    state: oneOf("active", "blocked", "waiting", "done"), updatedAt: timestamp },

  workstream: { workstreamId: id, workspaceId: id, title: line, objective: prose,
    coordinatorSessionId: nullable(id),
    state: oneOf("open", "paused", "complete", "cancelled"), createdAt: timestamp },

  task: { taskId: id, workstreamId: id, workspaceId: id, title: line,
    state: oneOf("pending", "in_progress", "review", "done", "blocked"),
    assigneeSessionId: nullable(id), dependsOn: listOf(id), acceptance: listOf(line),
    createdAt: timestamp },

  claim: { claimId: id, workspaceId: id, ownerSessionId: id, resource: resourceUri,
    mode: oneOf("shared", "exclusive"), enforcement: oneOf("advisory", "guarded"),
    reason: line, acquiredAt: timestamp, expiresAt: timestamp, generation: id },

  message: { messageId: id, workspaceId: id, fromSessionId: id,
    toParticipantIds: listOf(id),
    type: oneOf("note", "question", "answer", "contract_request", "contract_response",
      "decision_proposal", "decision_result", "blocker", "review_request",
      "review_result", "handoff"),
    subject: line, body: prose, priority: oneOf("low", "normal", "high", "urgent"),
    workstreamId: nullable(id), taskId: nullable(id), inReplyTo: nullable(id),
    requiresAck: flag, artifacts: listOf(artifactRef), sentAt: timestamp },

  receipt: { messageId: id, workspaceId: id, recipientParticipantId: id,
    state: oneOf("recorded", "queued", "injected", "seen", "acknowledged", "failed"),
    updatedAt: timestamp },

  decision: { decisionId: id, workspaceId: id, workstreamId: nullable(id), title: line,
    outcome: prose, authority: oneOf("human", "workstream", "policy"),
    decidedBy: listOf(id), evidence: listOf(artifactRef), supersedes: nullable(id),
    decidedAt: timestamp },

  artifact: { kind: artifactKind, uri: resourceUri, description: line },

  handoff: { handoffId: id, workspaceId: id, fromSessionId: id, toParticipantId: nullable(id),
    goal: line, status: oneOf("complete", "partial", "blocked"), completed: listOf(line),
    remaining: listOf(line), blockers: listOf(line), claimsToRelease: listOf(resourceUri),
    verification: listOf(artifactRef), artifacts: listOf(artifactRef), createdAt: timestamp },

  event: { sequence, eventId: id, workspaceId: id, actorSessionId: id, type: line,
    occurredAt: timestamp, payload: plainObject },
});

export const RECORD_KINDS = Object.freeze(Object.keys(RECORDS));

export function validateRecord(kind, value) {
  const fields = RECORDS[kind];
  if (fields === undefined) {
    throw new AccError(EXIT.DATA, `unknown record kind: ${kind}`, { kind });
  }
  plainObject(value, kind);
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new AccError(EXIT.DATA,
      `${kind} has an unknown schemaVersion: ${String(value.schemaVersion)}`,
      { kind, schemaVersion: value.schemaVersion });
  }
  for (const key of Object.keys(value)) {
    if (key === "schemaVersion" || key === "extensions") continue;
    if (!Object.hasOwn(fields, key)) {
      invalid(`${kind}.${key}`, "is not a known field", value[key]);
    }
  }
  for (const [field, check] of Object.entries(fields)) {
    if (!Object.hasOwn(value, field)) {
      throw new AccError(EXIT.DATA, `${kind} requires ${field}`, { kind, field });
    }
    check(value[field], field);
  }
  // Forward-compatible metadata is tolerated only inside a named container, so
  // an older reader can round-trip a newer writer's record without guessing
  // which unknown top-level keys are safe.
  if (Object.hasOwn(value, "extensions")) plainObject(value.extensions, "extensions");
  return value;
}
