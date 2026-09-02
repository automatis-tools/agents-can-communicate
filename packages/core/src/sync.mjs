import { AccError, EXIT } from "@agents-can-communicate/protocol";

import { computeAttention } from "./attention.mjs";
import { classifySessionPresence } from "./sessions.mjs";

const DEFAULT_LIMIT = 100;
const CURSOR = /^[0-9]{16}$/;
const SCOPES = Object.freeze(["delta", "full"]);

function assertScope(scope) {
  if (scope != null && !SCOPES.includes(scope)) {
    throw new AccError(EXIT.USAGE,
      `scope is one of ${SCOPES.join(", ")}; leave it out for ${SCOPES[0]}`, { scope });
  }
}

function assertCursor(cursor) {
  if (typeof cursor !== "string" || !CURSOR.test(cursor)) {
    throw new AccError(EXIT.USAGE,
      "a cursor is the 16-digit sequence a previous sync returned; "
      + "leave it out to start from the beginning", { cursor });
  }
}

export function createSyncService(ports, sessions) {
  const { store, clock, pidIsAlive } = ports;

  async function sync(input = {}) {
    if (input.cursor != null) assertCursor(input.cursor);
    assertScope(input.scope);
    const workspaceId = input.workspaceId ?? store.workspaceId;
    const now = clock.now();
    const located = input.sessionId === undefined
      ? null : await sessions.locateSession(input.sessionId, workspaceId);
    const session = located?.record ?? null;
    const durable = await store.snapshot(workspaceId);
    const snapshot = durable.workspace !== null
      ? durable
      : { ...durable,
        sessions: await store.ephemeral.list("session"),
        intents: await store.ephemeral.list("intent") };
    const page = await store.eventsSince(workspaceId, input.cursor ?? null,
      input.limit ?? DEFAULT_LIMIT);
    const attention = computeAttention(snapshot, { session,
      participantId: session?.participantId ?? input.participantId, now, pidIsAlive });
    const roster = snapshot.sessions.map(item => ({
      sessionId: item.sessionId,
      participantId: item.participantId,
      parentSessionId: item.parentSessionId,
      harness: item.harness,
      branch: item.branch ?? null,
      presence: classifySessionPresence(item, now, pidIsAlive),
    }));
    const peers = roster.filter(item => item.sessionId !== session?.sessionId
      && item.presence !== "offline");
    const solo = peers.length === 0 && attention.length === 0
      && snapshot.claims.length === 0;
    return {
      cursor: page.cursor,
      scope: input.scope === "full" ? "full" : "delta",
      solo,
      attention,
      roster,
      events: page.events,
      ...(input.scope === "full" ? { snapshot } : {}),
    };
  }

  return { sync };
}
