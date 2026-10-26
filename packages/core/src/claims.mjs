import { AccError, EXIT, SCHEMA_VERSION, createId, validateRecord }
  from "@agents-can-communicate/protocol";

import { claimResources, releaseSelectors, selectReleaseClaims } from "./claim-selectors.mjs";
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
  const { store, clock, ids, pidIsAlive } = ports;

  async function requireOwner(input, action, tx, allowEphemeral = false) {
    const current = tx === undefined
      ? (await sessions.locateSession(input.sessionId, input.workspaceId))?.record
      : tx.get("session", input.sessionId)
        ?? (allowEphemeral ? await store.ephemeral.get("session", input.sessionId) : null);
    if (current == null || current.state !== "open") {
      throw new AccError(EXIT.CONFLICT, `cannot ${action} from a session that is not open`,
        { sessionId: input.sessionId });
    }
    if (current.generation !== input.generation) {
      throw new AccError(EXIT.CONFLICT, `cannot ${action} with a replaced session generation`,
        { sessionId: input.sessionId });
    }
    return current;
  }

  function conflictWith(existing, owner, now, snapshotSessions) {
    const ownerSession = snapshotSessions.find(item => item.sessionId === existing.ownerSessionId);
    // Staleness is reported so the requester can decide what to do; it never
    // releases the claim on its own.
    const ownerPresence = ownerSession === undefined
      ? "offline"
      : classifySessionPresence(ownerSession, now, pidIsAlive);
    return new AccError(EXIT.CONFLICT, "the resource is already claimed", {
      claimId: existing.claimId,
      resource: existing.resource,
      ownerSessionId: existing.ownerSessionId,
      ownerPresence,
      expiresAt: existing.expiresAt,
      requestedBy: owner.sessionId,
    });
  }

  async function acquire(input, resources, batch) {
    const session = await requireOwner(input, "claim");
    resources = claimResources(resources);
    const workspaceId = session.workspaceId;
    await ensureMaterialised(ports, { workspaceId, descriptor: input.descriptor,
      reason: "durable_object" });
    return store.transaction(async tx => {
      await requireOwner(input, "claim", tx);
      const now = clock.now();
      const expiresAt = new Date(Date.parse(now) + (input.leaseSeconds ?? 1800) * 1000)
        .toISOString();
      const existing = tx.list("claim");
      const live = existing.filter(claim => isLive(claim, now));
      const mode = input.mode ?? "exclusive";
      const conflicts = resources.flatMap(resource => live
        .filter(claim => overlaps(claim.resource, resource)
          && claim.ownerSessionId !== session.sessionId
          && (claim.mode === "exclusive" || mode === "exclusive"))
        .map(claim => ({ requestedResource: resource,
          ...conflictWith(claim, session, now, tx.list("session")).details })));
      if (conflicts.length > 0) {
        if (!batch) {
          const { requestedResource, ...details } = conflicts[0];
          throw new AccError(EXIT.CONFLICT, "the resource is already claimed", details);
        }
        const message = "batch claim conflicts:\n" + conflicts.map(conflict =>
          `${conflict.requestedResource} overlaps ${conflict.resource}, held by ${conflict.ownerSessionId}`)
          .join("\n");
        throw new AccError(EXIT.CONFLICT, message, { conflicts });
      }
      // Validate every record before staging a write, including renewals.
      const records = resources.map(resource => {
        const mine = existing.find(claim => claim.ownerSessionId === session.sessionId
          && claim.resource === resource);
        const claimId = mine?.claimId ?? createId("claim");
        return { mine, record: validateRecord("claim", {
          schemaVersion: SCHEMA_VERSION,
          claimId,
          workspaceId,
          ownerSessionId: session.sessionId,
          resource,
          mode,
          enforcement: input.enforcement ?? "advisory",
          reason: input.reason,
          // Reuse a lapsed record, but start a new period of holding it.
          acquiredAt: mine !== undefined && isLive(mine, now) ? mine.acquiredAt : now,
          expiresAt,
          generation: ids.next("generation"),
        }) };
      });
      for (const { mine, record } of records) {
        const { claimId, resource } = record;
        tx.put("claim", claimId, record, tx.generationOf("claim", claimId));
        tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"), workspaceId,
          actorSessionId: session.sessionId, type: mine === undefined ? "claim.acquired"
            : "claim.renewed", occurredAt: now,
          payload: { claimId, resource, mode: record.mode } });
      }
      return records.map(item => item.record);
    }, { kinds: ["session", "claim"] });
  }

  async function renewClaim(input) {
    const session = await requireOwner(input, "renew");
    let record = null;
    await store.transaction(async tx => {
      await requireOwner(input, "renew", tx);
      const existing = tx.get("claim", input.claimId);
      if (existing === null || existing.ownerSessionId !== session.sessionId) {
        throw new AccError(EXIT.CONFLICT, "only the owning session generation may renew a claim",
          { claimId: input.claimId });
      }
      // A lapsed claim no longer holds its resource, so another session may
      // have taken it since. Acquire repeats the conflict check and reuses
      // the lapsed record when the resource is still free (#295). The clock
      // is read inside the transaction, where the check and the write agree.
      const now = clock.now();
      if (!isLive(existing, now)) {
        throw new AccError(EXIT.CONFLICT,
          `claim ${input.claimId} has lapsed; acquire the resource again`, { claimId: input.claimId });
      }
      const expiresAt = new Date(Date.parse(now) + (input.leaseSeconds ?? 1800) * 1000)
        .toISOString();
      record = { ...existing, expiresAt, generation: ids.next("generation") };
      tx.put("claim", input.claimId, record, tx.generationOf("claim", input.claimId));
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
        workspaceId: existing.workspaceId, actorSessionId: session.sessionId,
        type: "claim.renewed", occurredAt: now, payload: { claimId: input.claimId } });
    }, { kinds: ["session", "claim"] });
    return record;
  }

  async function removeClaims(input, selectors, { authority = null, reason = null } = {}) {
    const session = await requireOwner(input, "release");
    return store.transaction(async tx => {
      await requireOwner(input, "release", tx, true);
      const now = clock.now();
      const selected = selectReleaseClaims(tx, selectors, session.sessionId);
      for (const existing of selected) {
        const owned = existing.ownerSessionId === session.sessionId;
        if (!owned && authority !== "human" && authority !== "policy") {
          throw new AccError(EXIT.CONFLICT,
            "force release requires human or policy authority",
            { claimId: existing.claimId, authority });
        }
      }
      for (const existing of selected) {
        const owned = existing.ownerSessionId === session.sessionId;
        // Remove the live record; per-resource events retain its history.
        tx.remove("claim", existing.claimId, tx.generationOf("claim", existing.claimId));
        tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
          workspaceId: existing.workspaceId, actorSessionId: session.sessionId,
          type: owned ? "claim.released" : "claim.force_released", occurredAt: now,
          payload: { claimId: existing.claimId, authority,
            reason, replacedGeneration: existing.generation } });
      }
      return selected;
    }, { kinds: ["session", "claim"] });
  }

  return {
    acquireClaim: async input => (await acquire(input, [input.resource], false))[0],
    acquireClaims: input => acquire(input, input.resources, true),
    renewClaim,
    releaseClaims: async input => removeClaims(input, releaseSelectors(input)),
    releaseClaim: async input => { await removeClaims(input, { claimIds: [input.claimId] }); },
    forceReleaseClaim: async input => { await removeClaims(input, { claimIds: [input.claimId] },
      { authority: input.authority, reason: input.reason });
    },
  };
}
