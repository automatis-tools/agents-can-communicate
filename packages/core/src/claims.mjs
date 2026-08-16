import { AccError, EXIT, SCHEMA_VERSION, createId, validateRecord }
  from "@agents-can-communicate/protocol";

import { ensureMaterialised } from "./materialisation.mjs";
import { classifySessionPresence } from "./sessions.mjs";

const GLOB = "/**";

const split = resource => {
  const index = resource.indexOf(":");
  return { scheme: resource.slice(0, index), rest: resource.slice(index + 1) };
};

/**
 * Two resources overlap when they name the same thing or when one is a glob
 * prefix of the other. Comparison is per path segment, so `file:ab/c` is not
 * inside `file:a/**` - raw string prefixes are how this check usually goes
 * wrong. Adapters may add richer overlap keys; the core rule stays generic.
 */
export function overlaps(left, right) {
  if (left === right) return true;
  const a = split(left);
  const b = split(right);
  if (a.scheme !== b.scheme) return false;
  const covers = (glob, plain) => glob.rest.endsWith(GLOB)
    && (plain.rest === glob.rest.slice(0, -GLOB.length)
      || plain.rest.startsWith(`${glob.rest.slice(0, -GLOB.length)}/`));
  return covers(a, b) || covers(b, a);
}

const isLive = (claim, now) => Date.parse(claim.expiresAt) > Date.parse(now);

export function createClaimService(ports, sessions) {
  const { store, clock, ids } = ports;

  async function requireOwner(input, action) {
    const existing = await sessions.locateSession(input.sessionId, input.workspaceId);
    if (existing === null || existing.record.state !== "open") {
      throw new AccError(EXIT.CONFLICT, `cannot ${action} from a session that is not open`,
        { sessionId: input.sessionId });
    }
    if (existing.record.generation !== input.generation) {
      throw new AccError(EXIT.CONFLICT, `cannot ${action} with a replaced session generation`,
        { sessionId: input.sessionId });
    }
    return existing.record;
  }

  function conflictWith(existing, owner, now, snapshotSessions) {
    const ownerSession = snapshotSessions.find(item => item.sessionId === existing.ownerSessionId);
    // Staleness is reported so the requester can decide what to do; it never
    // releases the claim on its own.
    const ownerPresence = ownerSession === undefined
      ? "offline"
      : classifySessionPresence(ownerSession, now);
    return new AccError(EXIT.CONFLICT, "the resource is already claimed", {
      claimId: existing.claimId,
      resource: existing.resource,
      ownerSessionId: existing.ownerSessionId,
      ownerPresence,
      expiresAt: existing.expiresAt,
      requestedBy: owner.sessionId,
    });
  }

  async function acquireClaim(input) {
    const session = await requireOwner(input, "claim");
    const workspaceId = session.workspaceId;
    await ensureMaterialised(ports, { workspaceId, descriptor: input.descriptor,
      reason: "durable_object" });
    const now = clock.now();
    const expiresAt = new Date(Date.parse(now) + (input.leaseSeconds ?? 1800) * 1000)
      .toISOString();
    const snapshot = await store.snapshot(workspaceId);

    let record = null;
    await store.transaction(async tx => {
      const live = tx.list("claim", claim => isLive(claim, now));
      const mine = live.find(claim => claim.ownerSessionId === session.sessionId
        && claim.resource === input.resource);
      const blocking = live.find(claim => overlaps(claim.resource, input.resource)
        && claim.ownerSessionId !== session.sessionId
        && (claim.mode === "exclusive" || input.mode === "exclusive"));
      if (blocking !== undefined) throw conflictWith(blocking, session, now, snapshot.sessions);

      const claimId = mine?.claimId ?? createId("claim");
      record = validateRecord("claim", {
        schemaVersion: SCHEMA_VERSION,
        claimId,
        workspaceId,
        ownerSessionId: session.sessionId,
        resource: input.resource,
        mode: input.mode ?? "exclusive",
        enforcement: input.enforcement ?? "advisory",
        reason: input.reason,
        acquiredAt: mine?.acquiredAt ?? now,
        expiresAt,
        generation: ids.next("generation"),
      });
      tx.put("claim", claimId, record, tx.generationOf("claim", claimId));
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"), workspaceId,
        actorSessionId: session.sessionId, type: mine === undefined ? "claim.acquired"
          : "claim.renewed", occurredAt: now,
        payload: { claimId, resource: input.resource, mode: record.mode } });
    });
    return record;
  }

  async function renewClaim(input) {
    const session = await requireOwner(input, "renew");
    const now = clock.now();
    const expiresAt = new Date(Date.parse(now) + (input.leaseSeconds ?? 1800) * 1000)
      .toISOString();
    let record = null;
    await store.transaction(async tx => {
      const existing = tx.get("claim", input.claimId);
      if (existing === null || existing.ownerSessionId !== session.sessionId) {
        throw new AccError(EXIT.CONFLICT, "only the owning session generation may renew a claim",
          { claimId: input.claimId });
      }
      record = { ...existing, expiresAt, generation: ids.next("generation") };
      tx.put("claim", input.claimId, record, tx.generationOf("claim", input.claimId));
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
        workspaceId: existing.workspaceId, actorSessionId: session.sessionId,
        type: "claim.renewed", occurredAt: now, payload: { claimId: input.claimId } });
    });
    return record;
  }

  async function removeClaim(input, { authority, reason }) {
    const session = await requireOwner(input, "release");
    const now = clock.now();
    await store.transaction(async tx => {
      const existing = tx.get("claim", input.claimId);
      if (existing === null) {
        throw new AccError(EXIT.CONFLICT, "the claim does not exist", { claimId: input.claimId });
      }
      const owned = existing.ownerSessionId === session.sessionId;
      // Force release is an authority decision, not a peer decision. A
      // coordinator lease does not extend outside its own workstream.
      if (!owned && authority !== "human" && authority !== "policy") {
        throw new AccError(EXIT.CONFLICT,
          "force release requires human or policy authority",
          { claimId: input.claimId, authority: authority ?? null });
      }
      // The claim record is removed rather than tombstoned: a released claim is
      // not a claim, and every consumer of a snapshot would otherwise have to
      // re-derive liveness. The event log keeps the history.
      tx.remove("claim", input.claimId, tx.generationOf("claim", input.claimId));
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
        workspaceId: existing.workspaceId, actorSessionId: session.sessionId,
        type: owned ? "claim.released" : "claim.force_released", occurredAt: now,
        payload: { claimId: input.claimId, authority: authority ?? null,
          reason: reason ?? null, replacedGeneration: existing.generation } });
    });
  }

  return {
    acquireClaim,
    renewClaim,
    releaseClaim: input => removeClaim(input, { authority: null, reason: null }),
    forceReleaseClaim: input => removeClaim(input,
      { authority: input.authority, reason: input.reason }),
  };
}
