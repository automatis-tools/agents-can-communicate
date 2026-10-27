import { AccError, EXIT } from "./errors.mjs";
import { assertPortableId } from "./ids.mjs";

export const TRANSACTION_INDEXES = Object.freeze({
  messageByClientKey: Object.freeze({ kind: "message", fields: ["workspaceId", "fromParticipantId", "clientMessageId"] }),
  receiptsByMessage: Object.freeze({ kind: "receipt", fields: ["workspaceId", "messageId"] }),
  // A page reads a recipient's receipts that can still be listed (#306). An acknowledged
  // receipt never can, and neither can a note the recipient has read, so neither is kept:
  // the groups follow what is waiting, not the history. A receipt written before ACC kept
  // its message's obligation is kept while retrieved, since it may still be listable.
  receiptsByRecipientState: Object.freeze({ kind: "receipt",
    fields: ["workspaceId", "recipientParticipantId", "state"],
    keys: receipt => receipt.state === "acknowledged"
      || (receipt.state === "retrieved" && receipt.extensions?.obligation === "none") ? []
      : [[receipt.workspaceId, receipt.recipientParticipantId, receipt.state]] }),
  // The decisions that replace or withdraw a decision, one key for each decision they name,
  // so a reader can walk one decision group instead of reading every decision (#306).
  decisionsByTarget: Object.freeze({ kind: "message", fields: ["workspaceId", "messageId"],
    keys: message => message.kind !== "decision" ? []
      : (message.decisionChange?.messageIds ?? []).map(target => [message.workspaceId, target]) }),
});

export function assertIndexTuple(index, tuple) {
  const definition = Object.hasOwn(TRANSACTION_INDEXES, index) ? TRANSACTION_INDEXES[index] : null;
  if (definition === null || !Array.isArray(tuple) || tuple.length !== definition.fields.length) {
    throw new AccError(EXIT.DATA, "invalid transaction index tuple", { index });
  }
  tuple.forEach((value, position) => assertPortableId(value, definition.fields[position]));
  return tuple;
}

// An index keys each record by its fields, or by its own `keys`, which may give no key
// or several.
export function indexKeysFor(kind, record) {
  return Object.entries(TRANSACTION_INDEXES).filter(([, definition]) => definition.kind === kind)
    .flatMap(([index, definition]) => (definition.keys?.(record)
      ?? [definition.fields.map(field => record[field])])
      .map(tuple => ({ index, tuple: assertIndexTuple(index, tuple) })));
}
