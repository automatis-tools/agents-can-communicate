import { assertMessageSemantics, MESSAGE_KINDS, OBLIGATIONS } from "./conversations.mjs";
import { AccError, EXIT } from "./errors.mjs";
import { id, invalid, listOf, nullable, oneOf, plainObject, positiveInteger,
  resourceUri, sequence, text, timestamp } from "./fields.mjs";

export const SCHEMA_VERSION = 3;

const line = text();
const prose = text({ max: 4000, multiline: true });
const summary = text({ max: 280 });
const artifactKind = oneOf("file", "git", "url", "report", "image", "data");

/** @typedef {{ sequence: string, eventId: string, workspaceId: string,
 * actorSessionId: string, type: string, occurredAt: string, payload: object }} AccEvent */
/** @typedef {{ cursor: string, events: AccEvent[] }} EventPage */
/** @typedef {{ kind: string, priority: number, sourceId: string, summary: string }} AttentionItem */
/** @typedef {{ workspace: object, participants: object[], sessions: object[],
 * intents: object[], claims: object[], messages: object[], receipts: object[] }} WorkspaceSnapshot */

function closedObject(value, field, fields) {
  plainObject(value, field);
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) invalid(`${field}.${key}`, "is not a known field", value[key]);
  }
  for (const [key, check] of Object.entries(fields)) {
    if (!Object.hasOwn(value, key)) {
      throw new AccError(EXIT.DATA, `${field} requires ${key}`, { field, key });
    }
    check(value[key], `${field}.${key}`);
  }
  return value;
}

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

const handoffPayload = (value, field) => closedObject(value, field, {
  status: oneOf("complete", "partial", "blocked"),
  completed: listOf(line),
  remaining: listOf(line),
  blockers: listOf(line),
  verification: listOf(artifactRef),
});

const EVENT_TYPES = Object.freeze([
  "workspace.materialised",
  "session.opened", "session.closed",
  "intent.published", "intent.cleared",
  "claim.acquired", "claim.released", "claim.renewed", "claim.force_released",
  "message.recorded", "message.offered", "message.retrieved", "message.acknowledged",
  "message.offer_succeeded", "message.offer_failed",
]);

const eventType = oneOf(...EVENT_TYPES);
const receiptState = oneOf("queued", "offered", "retrieved", "acknowledged");

const DURABLE_RECORDS = Object.freeze({
  workspace: { workspaceId: id, displayName: line, source: oneOf("config", "git", "directory"),
    roots: listOf(line), createdAt: timestamp },

  participant: { participantId: id, workspaceId: id, displayName: line,
    kind: oneOf("agent", "human"), createdAt: timestamp },

  session: { sessionId: id, participantId: id, workspaceId: id, generation: id,
    harness: line, state: oneOf("open", "closed"), parentSessionId: nullable(id),
    checkoutRoot: nullable(line), branch: nullable(line), pid: nullable(positiveInteger),
    enforcement: oneOf("guarded", "advisory"), lifecycle: oneOf("managed", "manual"),
    heartbeatCadenceMs: positiveInteger, startedAt: timestamp, heartbeatAt: timestamp },

  intent: { sessionId: id, workspaceId: id, summary,
    mode: oneOf("observe", "explore", "edit", "review", "coordinate", "wait"),
    resourceHints: listOf(resourceUri),
    state: oneOf("active", "blocked", "waiting", "done"), updatedAt: timestamp },

  claim: { claimId: id, workspaceId: id, ownerSessionId: id, resource: resourceUri,
    mode: oneOf("shared", "exclusive"), enforcement: oneOf("advisory", "guarded"),
    reason: line, acquiredAt: timestamp, expiresAt: timestamp, generation: id },

  message: { messageId: id, threadId: id, clientMessageId: id, workspaceId: id,
    fromParticipantId: id, fromSessionId: id, toParticipantIds: listOf(id),
    kind: oneOf(...MESSAGE_KINDS), obligation: oneOf(...OBLIGATIONS),
    subject: line, body: prose, inReplyTo: nullable(id), artifacts: listOf(artifactRef),
    handoff: nullable(handoffPayload), sentAt: timestamp },

  receipt: { messageId: id, workspaceId: id, recipientParticipantId: id,
    state: receiptState, updatedAt: timestamp },

  event: { sequence, eventId: id, workspaceId: id, actorSessionId: id, type: eventType,
    occurredAt: timestamp, payload: plainObject },
});

const RECORDS = Object.freeze({
  ...DURABLE_RECORDS,
  deliveryBinding: { sessionId: id, generation: id, adapterId: id, clientVersion: line,
    availableModes: listOf(oneOf("nextTurn", "livePush", "replyRoute")),
    livePolicy: oneOf("off", "actionable", "all"), opaqueEndpointRef: prose,
    leaseUntil: timestamp },
});

export const RECORD_KINDS = Object.freeze(Object.keys(DURABLE_RECORDS));

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
    if (!Object.hasOwn(fields, key)) invalid(`${kind}.${key}`, "is not a known field", value[key]);
  }
  for (const [field, check] of Object.entries(fields)) {
    if (!Object.hasOwn(value, field)) {
      throw new AccError(EXIT.DATA, `${kind} requires ${field}`, { kind, field });
    }
    check(value[field], field);
  }
  if (Object.hasOwn(value, "extensions")) plainObject(value.extensions, "extensions");
  if (kind === "message") assertMessageSemantics(value);
  return value;
}
