import path from "node:path";
import { assertPortableId, validateRecord } from "@agents-can-communicate/protocol";
import { readJsonIfPresent } from "./atomic-json.mjs";
import { requireStoreIdentity } from "./identity.mjs";
import { assertStateBinding, statePath } from "./record-id.mjs";
import { ephemeralIsDeleted, stateGenerationIsDeleted } from "./retention.mjs";
import { storePaths } from "./store.mjs";

/** Inspect ownership without opening, creating, recovering, or locking the store. */
export async function readSessionRecord({ root, workspaceId, sessionId }) {
  assertPortableId(sessionId, "session id");
  const paths = storePaths(root);
  await requireStoreIdentity(paths, { workspaceId, create: false });
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
