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

// Every event ACC itself appends. Closed on purpose: `type` used to be free
// text, so a record written by hand validated cleanly and `acc doctor` called
// the store healthy. That is not theoretical - a session that could not run the
// CLI wrote its own events, inventing `task.completed`, and the store reported
// no problem.
const EVENT_TYPES = Object.freeze([
  "workspace.materialised",
  "session.opened", "session.closed",
  "intent.published", "intent.cleared",
  "workstream.created", "workstream.coordinator_acquired",
  "workstream.coordinator_released",
  "task.created", "task.claimed", "task.transitioned", "task.unblocked",
  "task.declined", "task.released",
  "claim.acquired", "claim.released", "claim.renewed", "claim.force_released",
  "message.sent", "decision.recorded", "handoff.created",
  // Delivery transitions and request outcomes are templated from their state,
  // so the set has to carry each one they can produce.
  ...["recorded", "queued", "injected", "seen", "acknowledged", "failed"]
    .map(state => `message.${state}`),
  ...["accepted", "declined", "review", "done", "released"]
    .map(outcome => `work.${outcome}`),
  "work.requested",
]);

const eventType = oneOf(...EVENT_TYPES);

const RECORDS = Object.freeze({
  workspace: { workspaceId: id, displayName: line, source: oneOf("config", "git", "directory"),
    roots: listOf(line), createdAt: timestamp },

  participant: { participantId: id, workspaceId: id, displayName: line,
    kind: oneOf("agent", "human"), createdAt: timestamp },

  // `enforcement` and `lifecycle` are what this session's harness can actually
  // do, declared at attach. The harness name does not imply them: the same
  // client guards or does not depending on its model and its approval mode, and
  // a peer deciding whether to rely on a claim needs the answer, not the brand.
  // A workspace spans every worktree of one repository, so the workspace id
  // cannot say which checkout a session is sitting in. Recorded at attach from
  // what discovery already resolved: without it nobody can tell which worktrees
  // have an owner, and asking cannot answer for the agents that are not running
  // - which are exactly the ones a clean-up is looking for.
  session: { sessionId: id, participantId: id, workspaceId: id, generation: id,
    harness: line, state: oneOf("open", "closed"), parentSessionId: nullable(id),
    checkoutRoot: nullable(line), branch: nullable(line),
    enforcement: oneOf("guarded", "advisory"), lifecycle: oneOf("managed", "manual"),
    heartbeatCadenceMs: positiveInteger, startedAt: timestamp, heartbeatAt: timestamp },

  intent: { sessionId: id, workspaceId: id, summary,
    mode: oneOf("observe", "explore", "edit", "review", "coordinate", "wait"),
    resourceHints: listOf(resourceUri), workstreamId: nullable(id),
    state: oneOf("active", "blocked", "waiting", "done"), updatedAt: timestamp },

  workstream: { workstreamId: id, workspaceId: id, title: line, objective: prose,
    coordinatorSessionId: nullable(id),
    state: oneOf("open", "paused", "complete", "cancelled"), createdAt: timestamp },

  // Two assignees, deliberately. `assigneeParticipantId` is who the work is
  // for and survives that agent restarting; `assigneeSessionId` is the exact
  // session doing it right now and dies with the process. Asking one field to
  // be both would either lose the request when a terminal closes or claim a
  // dead session is still working.
  task: { taskId: id, workstreamId: nullable(id), workspaceId: id, title: line,
    state: oneOf("pending", "in_progress", "review", "done", "blocked"),
    assigneeParticipantId: nullable(id), assigneeSessionId: nullable(id),
    // Who asked. Without it nothing could tell the requester that their work
    // was accepted, declined or finished - the task knew who it was for and
    // had no idea who was waiting on it.
    requestedByParticipantId: nullable(id),
    dependsOn: listOf(id), acceptance: listOf(line), detail: nullable(prose),
    createdAt: timestamp },

  claim: { claimId: id, workspaceId: id, ownerSessionId: id, resource: resourceUri,
    mode: oneOf("shared", "exclusive"), enforcement: oneOf("advisory", "guarded"),
    reason: line, acquiredAt: timestamp, expiresAt: timestamp, generation: id },

  // `fromParticipantId` beside the session: a session ends, and the one fact
  // that has to outlive it is who was speaking. Resolving the sender by looking
  // its session up meant the record could never be retired, and an agent whose
  // client had restarted stopped being told about its own unanswered question.
  message: { messageId: id, workspaceId: id, fromSessionId: id,
    fromParticipantId: id, toParticipantIds: listOf(id),
    type: oneOf("note", "question", "answer", "contract_request", "contract_response",
      "decision_proposal", "decision_result", "blocker", "review_request",
      "review_result", "handoff", "work_request", "work_response"),
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

  event: { sequence, eventId: id, workspaceId: id, actorSessionId: id, type: eventType,
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
