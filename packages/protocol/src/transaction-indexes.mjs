import { AccError, EXIT } from "./errors.mjs";
import { assertPortableId } from "./ids.mjs";

export const TRANSACTION_INDEXES = Object.freeze({
  messageByClientKey: Object.freeze({ kind: "message", fields: ["workspaceId", "fromParticipantId", "clientMessageId"] }),
  receiptsByMessage: Object.freeze({ kind: "receipt", fields: ["workspaceId", "messageId"] }),
});

export function assertIndexTuple(index, tuple) {
  const definition = Object.hasOwn(TRANSACTION_INDEXES, index) ? TRANSACTION_INDEXES[index] : null;
  if (definition === null || !Array.isArray(tuple) || tuple.length !== definition.fields.length) {
    throw new AccError(EXIT.DATA, "invalid transaction index tuple", { index });
  }
  tuple.forEach((value, position) => assertPortableId(value, definition.fields[position]));
  return tuple;
}

export function indexKeysFor(kind, record) {
  return Object.entries(TRANSACTION_INDEXES).filter(([, definition]) => definition.kind === kind)
    .map(([index, definition]) => ({ index,
      tuple: assertIndexTuple(index, definition.fields.map(field => record[field])) }));
}
