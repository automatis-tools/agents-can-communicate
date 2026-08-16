import { AccError, EXIT } from "./errors.mjs";
import { assertPortableId } from "./ids.mjs";

// Resource URIs are deliberately not identifiers: they carry a scheme and an
// opaque part that may hold slashes, globs, and fragments (file:src/**,
// doc:architecture#camera-contract). What they may not carry is whitespace or
// control bytes, which break every line-oriented tool that displays them.
const RESOURCE_URI = /^[a-z][a-z0-9+.-]*:[^\s]+$/;

// Written as code rather than a character-class literal: escaped control
// ranges in a regex are easy to corrupt silently in an editor or a patch, and
// a corrupted range fails open.
function hasControl(value, { allowNewline = false } = {}) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (allowNewline && (code === 10 || code === 13)) continue;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function invalid(field, message, value) {
  throw new AccError(EXIT.DATA, `${field} ${message}`, { field, value });
}

export const id = (value, field) => {
  try {
    return assertPortableId(value, field);
  } catch {
    return invalid(field, "must be a portable identifier", value);
  }
};

export const text = ({ max = 500, multiline = false } = {}) => (value, field) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(field, "must be a non-empty string", value);
  }
  if (value.length > max) invalid(field, `must be at most ${max} characters`, value);
  if (hasControl(value, { allowNewline: multiline })) {
    invalid(field, "must not contain control characters", value);
  }
  return value;
};

export const timestamp = (value, field) => {
  const milliseconds = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    invalid(field, "must be a canonical UTC timestamp", value);
  }
  return value;
};

export const oneOf = (...allowed) => (value, field) => {
  if (!allowed.includes(value)) {
    invalid(field, `must be one of ${allowed.join(", ")}`, value);
  }
  return value;
};

export const resourceUri = (value, field) => {
  if (typeof value !== "string" || !RESOURCE_URI.test(value) || hasControl(value)
    || value.length > 1024) {
    invalid(field, "must be a scheme-qualified resource URI", value);
  }
  return value;
};

export const listOf = inner => (value, field) => {
  if (!Array.isArray(value)) invalid(field, "must be an array", value);
  value.forEach((item, index) => inner(item, `${field}[${index}]`));
  return value;
};

export const nullable = inner => (value, field) =>
  (value === null ? null : inner(value, field));

export const flag = (value, field) => {
  if (typeof value !== "boolean") invalid(field, "must be a boolean", value);
  return value;
};

export const plainObject = (value, field) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(field, "must be an object", value);
  }
  return value;
};

// Event sequence numbers are zero-padded decimal strings so lexicographic
// order equals numeric order in a directory listing and in JSON.
export const sequence = (value, field) => {
  if (typeof value !== "string" || !/^[0-9]{16}$/.test(value)) {
    invalid(field, "must be a 16-digit zero-padded sequence", value);
  }
  return value;
};
