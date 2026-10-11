import { AccError, EXIT } from "@agents-can-communicate/protocol";

import { positiveNumber } from "./args.mjs";
import { canonicalClaim } from "./claim-spelling.mjs";

const list = value => value === undefined ? undefined : Array.isArray(value) ? value : [value];
const owner = options => ({ sessionId: options.session, generation: options.generation });

export async function runClaimCommand({ options, context }) {
  const resources = await Promise.all(list(options.resource)
    .map(resource => canonicalClaim(resource, context.descriptor)));
  const input = { ...owner(options), mode: options.mode ?? "exclusive",
    enforcement: options.enforcement ?? "advisory", reason: options.reason ?? "unspecified",
    leaseSeconds: options.lease ? positiveNumber(options.lease, "lease") : undefined,
    descriptor: context.descriptor };
  if (resources.length === 1) {
    const claim = await context.service.acquireClaim({ ...input, resource: resources[0] });
    return { data: claim, text: `claimed ${claim.resource}` };
  }
  const claims = await context.service.acquireClaims({ ...input, resources });
  return { data: { claims }, text: `claimed ${claims.length} resources` };
}

// Single-item authority keeps its existing lookup and ambiguity rules.
async function authorityClaim(resource, context) {
  const { claims } = await context.service.collectStatus({});
  const matching = claims.filter(claim => claim.resource === resource);
  if (matching.length === 0) throw new AccError(EXIT.DATA, `no claim on ${resource} to release`,
    { resource, held: claims.map(claim => claim.resource) });
  if (matching.length > 1) throw new AccError(EXIT.DATA,
    `${matching.length} claims on ${resource}; name the one you mean with --claim`,
    { resource, claims: matching.map(claim => claim.claimId) });
  return matching[0].claimId;
}

export async function runReleaseCommand({ options, context }) {
  const selectors = [options.claim, options.resource, options.all].filter(value => value !== undefined);
  if (selectors.length !== 1) throw new AccError(EXIT.USAGE,
    "release needs exactly one of --claim, --resource, or --all");
  const claimIds = list(options.claim);
  const resources = options.resource === undefined ? undefined
    : await Promise.all(list(options.resource).map(resource => canonicalClaim(resource, context.descriptor)));
  const scalar = options.all !== true && (claimIds ?? resources).length === 1;
  if (options.authority !== undefined) {
    if (!scalar) throw new AccError(EXIT.USAGE, "force-release authority requires a single claim");
    const claimId = claimIds?.[0] ?? await authorityClaim(resources[0], context);
    await context.service.forceReleaseClaim({ ...owner(options), claimId,
      authority: options.authority, reason: options.reason });
    return { data: { claimId }, text: `released ${claimId}` };
  }
  if (scalar && claimIds !== undefined) {
    const claimId = claimIds[0];
    await context.service.releaseClaim({ ...owner(options), claimId });
    return { data: { claimId }, text: `released ${claimId}` };
  }
  const released = await context.service.releaseClaims({ ...owner(options),
    ...(options.all === true ? { all: true } : resources !== undefined ? { resources } : { claimIds }) });
  if (scalar) {
    const claimId = released[0].claimId;
    return { data: { claimId }, text: `released ${claimId}` };
  }
  return { data: { claimIds: released.map(claim => claim.claimId) },
    text: `released ${released.length} claims` };
}
