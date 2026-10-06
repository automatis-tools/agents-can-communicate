import path from "node:path";

import { AccError, EXIT, assertPortableId } from "@agents-can-communicate/protocol";

import { encode, nameCommittedLater, publishAtomic, readJsonIfPresent } from "./atomic-json.mjs";

export const STORE_VERSION = 7;

export function identityPath(paths) {
  return path.join(paths.root, "protocol.json");
}

function assertIdentity(record, workspaceId, filePath, versions = [STORE_VERSION]) {
  if (!versions.includes(record?.storeVersion)) {
    const message = record?.storeVersion === 6
      ? "store contract 6 requires explicit migration: stop other store users and run acc doctor --migrate-store"
      : "unknown store version";
    throw new AccError(EXIT.DATA, message, { filePath,
      storeVersion: record?.storeVersion });
  }
  if (Object.keys(record).sort().join(",") !== "initialisedAt,storeVersion,workspaceId"
    || typeof record.initialisedAt !== "string" || !Number.isFinite(Date.parse(record.initialisedAt))) {
    throw new AccError(EXIT.DATA, "invalid store identity", { filePath });
  }
  assertPortableId(record.workspaceId, "store workspace id");
  if (record.workspaceId !== workspaceId) {
    throw new AccError(EXIT.DATA, "store belongs to a different workspace",
      { filePath, expected: workspaceId, actual: record.workspaceId });
  }
  return record;
}

/**
 * Establish or verify the store's identity before anything else happens.
 * Opening a directory that already belongs to another workspace must fail
 * rather than quietly adopt it: an initialisation that silently rewrites a
 * foreign store is the failure the reconciled prototype fails closed on, and
 * the same rule applies here.
 */
export async function requireStoreIdentity(paths, { workspaceId, clock, create = true,
  platform }) {
  assertPortableId(workspaceId, "workspace id");
  const filePath = identityPath(paths);
  const found = await readJsonIfPresent(filePath, paths.root);
  if (found !== null) return assertIdentity(found.value, workspaceId, filePath);
  if (!create) {
    throw new AccError(EXIT.DATA, "store is not initialised", { filePath });
  }
  const record = { storeVersion: STORE_VERSION, workspaceId, initialisedAt: clock.now() };
  try {
    // The journal's first pointer, published next, commits this name on
    // Windows; a crash before it leaves a directory the next open initialises.
    await publishAtomic(filePath, encode(record), { root: paths.root, tmpDir: paths.tmp,
      durability: nameCommittedLater(platform) });
  } catch (error) {
    // Losing this race is not a failure. Two agents starting together in a
    // workspace neither has opened before is the ordinary case, and the two
    // identity documents they write differ in one field - the moment each was
    // written - so the second was refused for "different bytes" and that agent
    // could not attach at all.
    //
    // What the store has to refuse is a directory belonging to a *different*
    // workspace, and that is decided below by reading what is actually there
    // rather than by whose bytes arrived first.
    if (error.code !== EXIT.CONFLICT) throw error;
  }
  const published = await readJsonIfPresent(filePath, paths.root);
  return assertIdentity(published.value, workspaceId, filePath);
}

export async function readStoreIdentity(paths) {
  const found = await readJsonIfPresent(identityPath(paths), paths.root);
  if (found === null) return null;
  return assertIdentity(found.value, found.value?.workspaceId, identityPath(paths));
}

export async function readMigrationIdentity(paths, workspaceId) {
  assertPortableId(workspaceId, "workspace id");
  const found = await readJsonIfPresent(identityPath(paths), paths.root);
  if (found === null) throw new AccError(EXIT.DATA, "store is not initialised", { filePath: identityPath(paths) });
  return assertIdentity(found.value, workspaceId, identityPath(paths), [6, STORE_VERSION]);
}
