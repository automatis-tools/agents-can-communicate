import path from "node:path";

import { AccError, EXIT, assertPortableId } from "@agents-can-communicate/protocol";

import { encode, publishAtomic, readJsonIfPresent } from "./atomic-json.mjs";

export const STORE_VERSION = 1;

export function identityPath(paths) {
  return path.join(paths.root, "protocol.json");
}

function assertIdentity(record, workspaceId, filePath) {
  if (record?.storeVersion !== STORE_VERSION) {
    throw new AccError(EXIT.DATA, "unknown store version", { filePath,
      storeVersion: record?.storeVersion });
  }
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
export async function requireStoreIdentity(paths, { workspaceId, clock, create = true }) {
  assertPortableId(workspaceId, "workspace id");
  const filePath = identityPath(paths);
  const found = await readJsonIfPresent(filePath, paths.root);
  if (found !== null) return assertIdentity(found.value, workspaceId, filePath);
  if (!create) {
    throw new AccError(EXIT.DATA, "store is not initialised", { filePath });
  }
  const record = { storeVersion: STORE_VERSION, workspaceId, initialisedAt: clock.now() };
  await publishAtomic(filePath, encode(record), { root: paths.root, tmpDir: paths.tmp });
  const published = await readJsonIfPresent(filePath, paths.root);
  return assertIdentity(published.value, workspaceId, filePath);
}

export async function readStoreIdentity(paths) {
  const found = await readJsonIfPresent(identityPath(paths), paths.root);
  if (found === null) return null;
  if (found.value?.storeVersion !== STORE_VERSION) {
    throw new AccError(EXIT.DATA, "unknown store version",
      { filePath: identityPath(paths), storeVersion: found.value?.storeVersion });
  }
  return found.value;
}
