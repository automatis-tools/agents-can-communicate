import path from "node:path";
import { assertPortableId, validateRecord } from "@agents-can-communicate/protocol";
import { readJsonIfPresent } from "./atomic-json.mjs";
import { readMigrationIdentity, requireStoreIdentity } from "./identity.mjs";
import { assertStateBinding, statePath } from "./record-id.mjs";
import { ephemeralIsDeleted, stateGenerationIsDeleted } from "./retention.mjs";
import { storePaths } from "./store.mjs";

/** Inspect ownership without opening, creating, recovering, or locking the store.
 * Legacy identity inspection is read-only metadata for runtime hold classification. */
export async function readSessionRecord({ root, workspaceId, sessionId, allowLegacyIdentity = false }) {
  assertPortableId(sessionId, "session id");
  const paths = storePaths(root);
  if (allowLegacyIdentity === true) await readMigrationIdentity(paths, workspaceId);
  else await requireStoreIdentity(paths, { workspaceId, create: false });
  const file = statePath(paths, "session", sessionId);
  const durable = await readJsonIfPresent(file, root);
  if (durable !== null) {
    const envelope = assertStateBinding(durable.value, "session", sessionId, file);
    if (!await stateGenerationIsDeleted(paths, root, "session", sessionId, envelope.generation)) {
      return validateRecord("session", envelope.record);
    }
  }
  const ephemeral = await readJsonIfPresent(path.join(paths.ephemeral, "session", `${sessionId}.json`), root);
  if (ephemeral === null || await ephemeralIsDeleted(paths, root, "session", sessionId)) return null;
  return validateRecord("session", ephemeral.value);
}

/** Read the one session's transport metadata without recovery, locks or renewal. */
export async function readDeliveryBindingRecord({ root, workspaceId, sessionId }) {
  assertPortableId(sessionId, "session id");
  const paths = storePaths(root);
  await requireStoreIdentity(paths, { workspaceId, create: false });
  const value = await readJsonIfPresent(
    path.join(paths.ephemeral, "deliveryBinding", `${sessionId}.json`), root);
  if (value === null || await ephemeralIsDeleted(paths, root, "deliveryBinding", sessionId)) return null;
  const binding = validateRecord("deliveryBinding", value.value);
  if (binding.sessionId !== sessionId) throw new Error("delivery binding does not match its path");
  return binding;
}
