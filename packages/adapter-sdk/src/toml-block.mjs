import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Two clients keep configuration ACC must add to in TOML, and ACC ships without
// dependencies. Parsing and re-emitting the file would mean writing a TOML
// round-tripper and losing the user's comments and formatting to it. Instead ACC
// owns a delimited region and never reads the rest: install replaces the region,
// uninstall deletes it, and everything outside comes back byte for byte.
export const BEGIN = "# >>> agents-can-communicate (managed; edits here are overwritten)";
export const END = "# <<< agents-can-communicate";

/**
 * Remove ACC's region and nothing else.
 *
 * Written to survive a file with no block, several blocks, or a block the user
 * has half-deleted: an unterminated marker consumes to end of file rather than
 * leaving stray table headers behind, which would fail the client's schema and
 * lock the user out of their own tool.
 */
export function stripBlock(source) {
  const kept = [];
  let inside = false;
  for (const line of source.split("\n")) {
    if (line.trimEnd() === BEGIN) { inside = true; continue; }
    if (inside) {
      if (line.trimEnd() === END) inside = false;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

export const renderBlock = body => [BEGIN, ...body, END].join("\n");

// TOML basic strings take backslash escapes. A path is user-controlled input, so
// it is escaped rather than trusted to be boring.
export const tomlString = value =>
  `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Replace ACC's region in a TOML file, creating the file if needed.
 *
 * The block goes at the end because a table header there closes whatever table
 * preceded it: appended anywhere else, the user's last section would swallow
 * ACC's keys.
 */
export async function writeTomlBlock(file, body) {
  const existing = await readFile(file, "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const withoutOurs = stripBlock(existing);
  const separator = withoutOurs === "" || withoutOurs.endsWith("\n") ? "" : "\n";
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${withoutOurs}${separator}${renderBlock(body)}\n`);
  return file;
}

/** Remove ACC's region, reporting whether anything was there. */
export async function removeTomlBlock(file) {
  const existing = await readFile(file, "utf8").catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing === null) return false;
  const stripped = stripBlock(existing);
  if (stripped === existing) return false;
  await writeFile(file, stripped);
  return true;
}
