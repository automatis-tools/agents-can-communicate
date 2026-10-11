import { AccError, EXIT, assertMatchableResource, assertPortableId,
  assertResourceUri, normaliseResource } from "@agents-can-communicate/protocol";

const invalid = message => { throw new AccError(EXIT.USAGE, message); };

function resourceSelector(resource) {
  assertMatchableResource(resource, invalid);
  return assertResourceUri(normaliseResource(resource), "resource");
}

function claimIdSelector(claimId, field) {
  try { return assertPortableId(claimId, field); }
  catch (error) {
    if (!(error instanceof AccError)) throw error;
    invalid(`${field} must be a portable identifier`);
  }
}

// URI normalization and identifier validation must precede resolving a session:
// an invalid selector must not create presence or a persistent session binding.
export function validateClaimSelectors(name, args) {
  if (name !== "acc_claim" && name !== "acc_release") return args;
  const result = { ...args };
  if (args.resource !== undefined) result.resource = resourceSelector(args.resource);
  if (args.resources !== undefined) {
    result.resources = args.resources.map(resourceSelector);
    if (new Set(result.resources).size !== result.resources.length) {
      invalid("arguments.resources contains duplicate selectors after normalization");
    }
  }
  if (args.claimId !== undefined) claimIdSelector(args.claimId, "arguments.claimId");
  args.claimIds?.forEach((id, index) => claimIdSelector(id, `arguments.claimIds[${index}]`));
  return result;
}

export async function claimTool(service, owner, args) {
  if (args.action === "renew") return service.renewClaim({ ...owner,
    claimId: args.claimId, leaseSeconds: args.leaseSeconds });
  const input = { ...owner, mode: args.mode ?? "exclusive", enforcement: "advisory",
    reason: args.reason ?? "unspecified", leaseSeconds: args.leaseSeconds };
  if (args.resources !== undefined) {
    return { claims: await service.acquireClaims({ ...input, resources: args.resources }) };
  }
  return service.acquireClaim({ ...input, resource: args.resource });
}

export async function releaseTool(service, owner, args) {
  if (args.claimId !== undefined) {
    await service.releaseClaim({ ...owner, claimId: args.claimId });
    return { released: args.claimId };
  }
  const selected = args.resource !== undefined ? { resources: [args.resource] } : args;
  const claims = await service.releaseClaims({ ...owner, ...selected });
  const released = claims.map(claim => claim.claimId);
  return { released: args.resource !== undefined ? released[0] : released };
}
