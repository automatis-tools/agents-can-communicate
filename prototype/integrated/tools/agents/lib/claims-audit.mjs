import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { writeJsonAtomic } from "./atomic-json.mjs";
import { CommsError, EXIT } from "./errors.mjs";
import { validateAgentId, validateClaim, validateLock } from "./schema.mjs";

function data(message) { throw new CommsError(message, EXIT.DATA); }
function validTime(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
export function validateClaimAudit(value) {
  const keys = ["action", "actor_agent", "recorded_at", "schema_version", "target"];
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join() !== keys.join() || value.schema_version !== 1
    || !validTime(value.recorded_at)) data("invalid claims audit");
  if (value.action === "force_release_stale_claim") {
    if (value.actor_agent === null) data("force release audit has no actor");
    validateAgentId(value.actor_agent); validateClaim(value.target);
    if (Date.parse(value.target.expires_at) > Date.parse(value.recorded_at))
      data("force release audit target was not stale");
  } else if (value.action === "repair_stale_claim_lock") {
    if (value.actor_agent !== null) data("claim lock repair audit has an actor");
    validateLock(value.target);
    if (Date.parse(value.recorded_at) - Date.parse(value.target.acquired_at) <= 60_000)
      data("claim lock repair audit target was not stale");
  } else data("invalid claims audit action");
  return value;
}
export function claimLockDigest(owner) {
  return createHash("sha256").update(JSON.stringify([
    owner.schema_version, owner.owner_agent, owner.pid, owner.acquired_at,
  ])).digest("hex");
}
export function staleClaimLockDestination(context, owner) {
  return path.join(context.paths.quarantine, `claims-lock-stale-${claimLockDigest(owner)}`);
}
export async function writeClaimAudit(context, action, actorAgent, target) {
  const audit = validateClaimAudit({ schema_version: 1, action, actor_agent: actorAgent,
    recorded_at: context.now().toISOString(), target });
  const uuid = (context.randomUUID ?? randomUUID)();
  const filePath = path.join(context.paths.quarantine, `claims-audit-${uuid}.json`);
  await writeJsonAtomic(filePath, audit, { tmpDir: context.paths.tmp, exclusive: true });
  return { audit, filePath };
}
