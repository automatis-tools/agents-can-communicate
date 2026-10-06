import path from "node:path";
import { AccError, EXIT, validateRecord } from "@agents-can-communicate/protocol";
import { listDirectoryEntries, listJsonFiles, readJsonIfPresent } from "./atomic-json.mjs";
import { assertStateBinding, statePath } from "./record-id.mjs";
import { stateGenerationIsDeleted } from "./retention.mjs";
import { assertPublicationDeadline } from "./deadline.mjs";

export async function readStateEnvelope(paths, { root, workspaceId }, kind, id) {
  const filePath = statePath(paths, kind, id);
  const found = await readJsonIfPresent(filePath, root);
  if (found === null) return null;
  const envelope = assertStateBinding(found.value, kind, id, filePath);
  if (await stateGenerationIsDeleted(paths, root, kind, id, envelope.generation)) return null;
  validateRecord(kind, envelope.record);
  if (workspaceId !== undefined && envelope.record.workspaceId !== workspaceId) {
    throw new AccError(EXIT.DATA, "state record belongs to a different workspace",
      { filePath, expected: workspaceId, actual: envelope.record.workspaceId });
  }
  return envelope;
}

export async function listState(paths, root, kind, deadlineAt) {
  const envelopes = [];
  for (const filePath of await listJsonFiles(path.join(paths.state, kind), { root })) {
    assertPublicationDeadline(deadlineAt);
    const envelope = await readStateEnvelope(paths, { root }, kind, path.basename(filePath, ".json"));
    if (envelope !== null) envelopes.push(envelope);
  }
  return envelopes;
}

export async function loadStateEnvelopes(paths, { root, deadlineAt }, wanted = null) {
  const loaded = new Map();
  const kinds = (await listDirectoryEntries(paths.state, { root }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name)
    .filter(kind => wanted === null || wanted.has(kind));
  for (const kind of kinds) {
    for (const envelope of await listState(paths, root, kind, deadlineAt)) {
      loaded.set(`${envelope.kind}:${envelope.id}`, envelope);
    }
  }
  return loaded;
}
