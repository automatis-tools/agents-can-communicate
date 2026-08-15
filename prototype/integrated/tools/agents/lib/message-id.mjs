import { CommsError, EXIT } from "./errors.mjs";

const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function validateMessageId(value, name = "message id") {
  if (typeof value !== "string" || !PORTABLE_ID.test(value)
    || value.endsWith(".") || WINDOWS_DEVICE.test(value)) {
    throw new CommsError(`invalid ${name}`, EXIT.DATA, { value });
  }
  return value;
}
