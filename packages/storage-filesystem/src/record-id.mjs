import path from "node:path";

import { AccError, EXIT, assertPortableId } from "@agents-can-communicate/protocol";

// State files carry an envelope rather than the bare record. The envelope names
// the kind, the id, and the generation, so a file that is moved or renamed can
// be detected instead of being trusted because of where it happens to sit.
// This is the generalisation of the reconciled prototype's filename binding.
export function stateEnvelope(kind, id, generation, record) {
  return { kind, id, generation, record };
}

export function statePath(paths, kind, id) {
  assertPortableId(kind, "record kind");
  assertPortableId(id, "record id");
  return path.join(paths.state, kind, `${id}.json`);
}

export function assertStateBinding(envelope, kind, id, filePath) {
  const shaped = envelope !== null && typeof envelope === "object"
    && typeof envelope.kind === "string" && typeof envelope.id === "string"
    && typeof envelope.generation === "string";
  if (!shaped) {
    throw new AccError(EXIT.DATA, "state record is not a valid envelope", { filePath });
  }
  if (envelope.kind !== kind || envelope.id !== id) {
    throw new AccError(EXIT.DATA, "state record does not match its path",
      { filePath, expected: { kind, id }, actual: { kind: envelope.kind, id: envelope.id } });
  }
  return envelope;
}

export function eventPath(paths, sequence) {
  return path.join(paths.events, `${sequence}.json`);
}

export function assertEventBinding(event, filePath) {
  const sequence = path.basename(filePath, ".json");
  if (event?.sequence !== sequence) {
    throw new AccError(EXIT.DATA, "event record does not match its filename",
      { filePath, expected: sequence, actual: event?.sequence });
  }
  return event;
}
