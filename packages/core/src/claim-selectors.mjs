import { AccError, EXIT, assertMatchableResource, assertPortableId,
  assertResourceUri, normaliseResource } from "@agents-can-communicate/protocol";

const usage = message => { throw new AccError(EXIT.USAGE, message); };

export function uniqueList(value, name, normalise = item => item) {
  if (!Array.isArray(value) || value.length === 0) usage(`${name} must be a nonempty array`);
  const result = value.map(item => {
    if (typeof item !== "string" || item.length === 0) usage(`${name} must contain nonempty strings`);
    return normalise(item);
  });
  if (new Set(result).size !== result.length) usage(`${name} contains duplicate selectors`);
  return result;
}

export function claimResources(value) {
  return uniqueList(value, "resources", resource => {
    assertMatchableResource(resource, usage);
    const normalised = normaliseResource(resource);
    try { return assertResourceUri(normalised, "resource"); }
    catch (error) {
      if (!(error instanceof AccError)) throw error;
      throw new AccError(EXIT.USAGE, error.message, error.details);
    }
  });
}

export function releaseSelectors(input) {
  const present = ["claimIds", "resources", "all"].filter(key => input[key] !== undefined);
  if (present.length !== 1 || (present[0] === "all" && input.all !== true)) {
    usage("release needs exactly one of claimIds, resources, or all: true");
  }
  if (input.authority !== undefined) usage("batch release does not accept force-release authority");
  if (input.all === true) return { all: true };
  if (input.resources !== undefined) return { resources: claimResources(input.resources) };
  return { claimIds: uniqueList(input.claimIds, "claimIds", id => {
    try { return assertPortableId(id, "claim id"); }
    catch (error) {
      if (!(error instanceof AccError)) throw error;
      throw new AccError(EXIT.USAGE, error.message, error.details);
    }
  }) };
}

export function selectReleaseClaims(tx, selectors, sessionId) {
  if (selectors.all === true) return tx.list("claim", claim => claim.ownerSessionId === sessionId);
  if (selectors.claimIds !== undefined) return selectors.claimIds.map(claimId => {
    const claim = tx.get("claim", claimId);
    if (claim === null) throw new AccError(EXIT.CONFLICT, "the claim does not exist", { claimId });
    return claim;
  });
  const claims = tx.list("claim");
  return selectors.resources.map(resource => {
    const mine = claims.filter(claim => claim.resource === resource && claim.ownerSessionId === sessionId);
    if (mine.length === 0) throw new AccError(EXIT.DATA, `no claim on ${resource} to release`,
      { resource, held: claims.map(claim => claim.resource) });
    if (mine.length > 1) throw new AccError(EXIT.DATA,
      `${mine.length} claims on ${resource}; name the one you mean with --claim`,
      { resource, claims: mine.map(claim => claim.claimId) });
    return mine[0];
  });
}
