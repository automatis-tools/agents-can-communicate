import { id, invalid, listOf, oneOf, plainObject } from "./fields.mjs";

export function assertDecisionChange(value, field = "decisionChange") {
  plainObject(value, field);
  for (const key of Object.keys(value)) {
    if (!["action", "messageIds"].includes(key)) invalid(`${field}.${key}`, "is not a known field", value[key]);
  }
  oneOf("replace", "withdraw")(value.action, `${field}.action`);
  listOf(id)(value.messageIds, `${field}.messageIds`);
  if (value.messageIds.length < 1 || value.messageIds.length > 16
    || new Set(value.messageIds).size !== value.messageIds.length) {
    invalid(`${field}.messageIds`, "requires 1 to 16 unique decision message ids", value.messageIds);
  }
  return value;
}
