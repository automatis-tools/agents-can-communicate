import path from "node:path";

import { editJson } from "./json-text.mjs";

const MARKER = "acc:owned";
// Ownership of single entries inside a container someone else also writes to.
// `enabledPlugins` in a Claude Code settings file holds every plugin the user
// has, so taking the whole key would destroy them - and giving it back on
// uninstall would destroy them again.
const ENTRY_MARKER = "acc:ownedEntries";
// Containers ACC had to create. Recorded separately from whole owned keys:
// creating one is permission to remove it when it ends up empty, not permission
// to take whatever the user has put in it since.
const CREATED_MARKER = "acc:createdContainers";
// The file itself, as opposed to a container inside it. Recorded at install
// because uninstall cannot tell afterwards: a settings file holding `{}` looks
// the same whether ACC made it or the user did, and deleting the user's would
// be the same overreach as taking a container they had put entries in.
const CREATED_FILE = "acc:createdFile";

/**
 * Merge ACC entries into a user's config and record ownership, so uninstall can
 * remove exactly what ACC added and nothing else.
 *
 * The ownership record is what makes uninstall safe: without it the only way to
 * remove entries is to guess by shape, which is how a tool deletes a user's
 * unrelated hook that happened to look similar.
 */
export function mergeOwnedConfig(existing, additions, { owner = MARKER } = {}) {
  const merged = { ...existing };
  const owned = new Set(existing?.[owner] ?? []);
  for (const [key, value] of Object.entries(additions)) {
    merged[key] = value;
    owned.add(key);
  }
  merged[owner] = [...owned].sort();
  return merged;
}

export function removeOwnedConfig(existing, { owner = MARKER } = {}) {
  const owned = new Set(existing?.[owner] ?? []);
  const result = {};
  for (const [key, value] of Object.entries(existing ?? {})) {
    // Unrelated keys survive untouched, including keys a user added by hand
    // under a name ACC also uses elsewhere.
    if (key !== owner && !owned.has(key)) result[key] = value;
  }
  return result;
}

export function ownedKeys(existing, { owner = MARKER } = {}) {
  return [...(existing?.[owner] ?? [])];
}

/**
 * Add entries inside containers ACC shares with the user.
 *
 * Records `[container, key]` pairs, so uninstall removes exactly the entries ACC
 * added. A container ACC had to create is recorded too, but as a container it may
 * clean up rather than as a key it owns: an empty one left behind is litter, and
 * one the user has since put their own entries into is theirs.
 */
export function mergeOwnedEntries(existing, additions,
  { entryOwner = ENTRY_MARKER, createdOwner = CREATED_MARKER, createdFile } = {}) {
  const merged = { ...existing };
  if (createdFile === true) merged[CREATED_FILE] = true;
  const entries = new Map((existing?.[entryOwner] ?? [])
    .map(pair => [`${pair[0]}\u0000${pair[1]}`, pair]));
  const created = new Set(existing?.[createdOwner] ?? []);

  for (const [container, values] of Object.entries(additions)) {
    if (!Object.hasOwn(existing ?? {}, container)) created.add(container);
    merged[container] = { ...(existing?.[container] ?? {}) };
    for (const [key, value] of Object.entries(values)) {
      merged[container][key] = value;
      entries.set(`${container}\u0000${key}`, [container, key]);
    }
  }

  merged[entryOwner] = [...entries.values()]
    .sort((left, right) => left.join("/").localeCompare(right.join("/")));
  if (created.size > 0) merged[createdOwner] = [...created].sort();
  return merged;
}

/** Remove only the entries ACC recorded adding, leaving every other one. */
export function removeOwnedEntries(existing,
  { owner = MARKER, entryOwner = ENTRY_MARKER, createdOwner = CREATED_MARKER } = {}) {
  const result = { ...(existing ?? {}) };
  for (const [container, key] of result[entryOwner] ?? []) {
    if (result[container] === null || typeof result[container] !== "object") continue;
    const remaining = { ...result[container] };
    delete remaining[key];
    result[container] = remaining;
  }
  // A container ACC created goes only if nothing is left in it. Taking it
  // outright would delete entries the user added after the install - the exact
  // loss that recording ownership per entry exists to prevent.
  for (const container of result[createdOwner] ?? []) {
    const value = result[container];
    if (value !== null && typeof value === "object" && Object.keys(value).length === 0) {
      delete result[container];
    }
  }
  delete result[entryOwner];
  delete result[createdOwner];
  delete result[CREATED_FILE];
  return removeOwnedConfig(result, { owner });
}

export function ownedEntries(existing, { entryOwner = ENTRY_MARKER } = {}) {
  return (existing?.[entryOwner] ?? []).map(pair => [...pair]);
}

/**
 * Write JSON back into someone else's file, in that file's own style.
 *
 * ACC re-emits what it edits, and re-emitting with a fixed style rewrites bytes
 * it was not asked to touch. Measured after an install and uninstall that
 * changed nothing else: three clients' configs came back one byte longer, a
 * trailing newline appended to files that had none. It is the same defect that
 * was found once in Claude Code's registries and fixed there by hand - fixed for
 * two files rather than for the shape, so the other three kept doing it.
 *
 * The style is read from the file rather than declared per client: what a client
 * writes is a fact about the client, and asking the file cannot go stale.
 * Absent file, absent style: a file ACC creates is its own, and gets the
 * conventional trailing newline.
 */
export function jsonStyleOf(text) {
  if (typeof text !== "string") return { indent: 2, trailingNewline: true };
  // The whitespace itself, not a count of it. `JSON.stringify` takes a string
  // for its indent, so a tab-indented file stays tab-indented; measuring the
  // length instead turned one tab into one space and reformatted every line of
  // a file this exists to leave alone. Matched without `\s`, which would span
  // the blank line before an indented one and report its own newline as indent.
  const indented = /\n([ \t]+)\S/.exec(text);
  // A file written on one line was written that way on purpose, and expanding it
  // is the same unasked-for rewrite as changing its indent.
  const oneLine = !text.trimEnd().includes("\n");
  // Ten is what `JSON.stringify` itself honours; more is silently truncated,
  // and truncating here keeps what is written equal to what was measured.
  return {
    indent: oneLine ? 0 : (indented === null ? 2 : indented[1].slice(0, 10)),
    trailingNewline: text.endsWith("\n"),
  };
}

/**
 * Write a file ACC did not create, keeping the shape of what was there.
 *
 * Unchanged content is not rewritten at all, so a second install touches
 * nothing. A file that does not exist yet is ACC's to create, and gets the
 * conventional trailing newline.
 *
 * What is there is edited rather than re-emitted. Reading the style back out of
 * the file kept the indentation, and still reformatted everything the style
 * could not describe: a nested object a person had written on one line came
 * back as three, and a blank line between sections was gone. The bytes are
 * theirs, and the diff ACC leaves should be of what it changed.
 */
export async function writeForeignJson(file, value, { readFile, writeFile, mkdir }) {
  const current = await readFile(file, "utf8").catch(() => null);
  const style = jsonStyleOf(current);
  // Null when the original cannot be read, or when the edit came back meaning
  // something other than it was asked to write. Then this is the whole-file
  // re-emit it has always been.
  const spliced = typeof current === "string" ? editJson(current, value, style.indent) : null;
  const text = spliced === null
    ? formatJsonAs(value, style)
    : (style.trailingNewline === false ? spliced : `${spliced}\n`);
  if (current === text) return false;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return true;
}

export function formatJsonAs(value, style) {
  const measured = style?.indent;
  const indent = typeof measured === "string" && measured !== "" ? measured
    : (Number.isInteger(measured) && measured >= 0 ? measured : 2);
  const text = JSON.stringify(value, null, indent);
  return style?.trailingNewline === false ? text : `${text}\n`;
}

/**
 * Remove a file ACC wrote once nothing is left in it.
 *
 * The same rule as a container ACC created: what is empty was ACC's alone, and
 * leaving it is litter in a home that did not have it. Measured after an install
 * and uninstall in a home that started with nothing - four files left behind,
 * two of them empty, one a marketplace manifest naming ACC's own marketplace.
 *
 * It was already fixed for two registries. The fixture that proved it seeded
 * every config first, so the branch where ACC creates the file was never taken:
 * the instance was fixed and the shape was not.
 */
export function acccreatedFile(value) {
  return value?.[CREATED_FILE] === true;
}

export async function removeIfEmpty(file, { readFile, rm, isEmpty, created = true }) {
  if (created !== true) return false;
  const current = await readFile(file, "utf8").catch(() => null);
  if (current === null) return false;
  let empty;
  try {
    empty = isEmpty(current);
  } catch {
    // Unparseable is not empty. A file nobody can read is the user's to fix,
    // and deleting it would take whatever it was meant to hold.
    return false;
  }
  if (!empty) return false;
  await rm(file, { force: true });
  return true;
}

/** Nothing but whitespace, for the clients whose config is TOML. */
export const blankText = text => text.trim() === "";

/** An object with no keys, or only the ones named as ACC's own. */
export const blankJson = (ours = []) => text => {
  const value = JSON.parse(text);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value)
    .every(([key, held]) => ours.includes(key)
      || (Array.isArray(held) ? held.length === 0
        : held !== null && typeof held === "object" && Object.keys(held).length === 0));
};
