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

// How many records of one kind are read at once. One at a time, a turn spent
// 0.4 s reading a workspace of a few thousand records; sixteen read it in 0.15 s
// on the same Mac (#298). The order of the listing is kept.
export const LIST_READS = 16;

export async function listState(paths, root, kind, deadlineAt) {
  const files = await listJsonFiles(path.join(paths.state, kind), { root });
  const envelopes = new Array(files.length).fill(null);
  let next = 0;
  let failed = false;
  const reader = async () => {
    while (!failed && next < files.length) {
      const index = next++;
      try {
        assertPublicationDeadline(deadlineAt);
        envelopes[index] = await readStateEnvelope(paths, { root }, kind,
          path.basename(files[index], ".json"));
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LIST_READS, files.length) }, reader));
  return envelopes.filter(envelope => envelope !== null);
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
