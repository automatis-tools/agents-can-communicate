import { createHash } from "node:crypto";
import { chmod, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";

// Retirement of the shell half of 0.7.x native delivery: one marked PATH block
// in the user's zsh rc and one `claude` shim in an ACC-owned directory. ACC no
// longer writes either; `acc install`, `acc update` and `acc uninstall` remove
// what an older version wrote. Every byte was recorded with its hash, so only
// what is still ACC's is removed, and an edited block or shim is kept.

export const BLOCK_BEGIN = "# >>> agents-can-communicate native delivery >>>";
export const BLOCK_END = "# <<< agents-can-communicate native delivery <<<";
export const SHIM_MARKER = "# agents-can-communicate native delivery shim";

const sha256 = text => createHash("sha256").update(text).digest("hex");
const defaultIo = Object.freeze({ readFile, writeFile, chmod, rename, rm, rmdir, readdir });

async function readText(io, file) {
  try {
    return await io.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomic(io, file, content, mode) {
  const temporary = `${file}.${process.pid}.tmp`;
  await io.writeFile(temporary, content, { mode });
  await io.rename(temporary, file);
  await io.chmod(file, mode);
}

// The block's exact span inside the rc text, or null. The block is matched by
// its two sentinel lines so a user's other lines are never touched.
export function locateBlock(text) {
  if (typeof text !== "string") return null;
  const begin = text.indexOf(BLOCK_BEGIN);
  if (begin === -1 || (begin > 0 && text[begin - 1] !== "\n")) return null;
  const endLine = text.indexOf(BLOCK_END, begin);
  if (endLine === -1) return null;
  const end = text.indexOf("\n", endLine);
  return { start: begin, end: end === -1 ? text.length : end + 1 };
}

export async function uninstallShellBootstrap({ ownership, io = defaultIo }) {
  const result = { ok: true, reasonCode: null, removedShims: [], keptShims: [],
    missingShims: [], rcBlock: "absent" };
  for (const shim of ownership?.shims ?? []) {
    const content = await readText(io, shim.path);
    if (content === null) { result.missingShims.push(shim.path); continue; }
    if (sha256(content) !== shim.sha256) { result.keptShims.push(shim.path); continue; }
    await io.rm(shim.path, { force: true });
    result.removedShims.push(shim.path);
  }
  const shimDir = ownership?.shimDir;
  let remaining = [];
  if (typeof shimDir === "string") {
    const names = await io.readdir(shimDir).catch(() => []);
    for (const name of names) {
      const content = await readText(io, path.join(shimDir, name));
      if (content !== null && content.includes(SHIM_MARKER)) remaining.push(name);
    }
  }
  const rcFile = ownership?.rcFile;
  const text = typeof rcFile?.path === "string" ? await readText(io, rcFile.path) : null;
  const span = locateBlock(text);
  if (span !== null) {
    const block = text.slice(span.start, span.end);
    if (sha256(block) !== rcFile.blockSha256) {
      result.rcBlock = "modified";
      result.ok = false;
      result.reasonCode = "rc_block_modified";
    } else if (remaining.length > 0) {
      result.rcBlock = "kept";
    } else {
      await writeAtomic(io, rcFile.path, text.slice(0, span.start) + text.slice(span.end), 0o600);
      result.rcBlock = "removed";
    }
  }
  if (typeof shimDir === "string" && remaining.length === 0 && result.keptShims.length === 0) {
    await io.rmdir(shimDir).catch(() => null);
  }
  return result;
}
