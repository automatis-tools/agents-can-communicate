import { randomBytes as nodeRandomBytes } from "node:crypto";

import { AccError, EXIT } from "./errors.mjs";

// Identifiers become path segments and record filenames on every backend, so
// the alphabet is the intersection of what POSIX and Windows accept safely:
// no separators, no control characters, no reserved device names, no trailing
// dot, and a leading alphanumeric so nothing is hidden or looks like ".." .
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function assertPortableId(value, label) {
  if (typeof value !== "string" || !PORTABLE_ID.test(value)
    || value.endsWith(".") || WINDOWS_DEVICE.test(value)) {
    throw new AccError(EXIT.DATA, `invalid ${label}`, { value });
  }
  return value;
}

export function createId(kind, randomBytes = nodeRandomBytes) {
  assertPortableId(kind, "kind");
  // base64url keeps the payload inside the portable alphabet: unlike base64 it
  // emits no "/", "+", or "=" padding.
  return `${kind}_${Buffer.from(randomBytes(16)).toString("base64url")}`;
}
