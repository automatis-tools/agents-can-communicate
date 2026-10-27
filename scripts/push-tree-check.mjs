#!/usr/bin/env node
// A working-tree receipt may certify only the exact clean pushed HEAD tree.
// Read blobs directly: index flags, stat/fsmonitor and ignores cannot prove bytes.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, readFile, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { Script } from "node:vm";
import { testFingerprint } from "./gate-cache.mjs";

const run = promisify(execFile);
const administrativeDocs = new Set([".superpowers", ".agents", ".idea"]);
async function harmlessAdministrativeFile(file, name, entry) {
  if (!entry.isFile() || !administrativeDocs.has(name.split("/")[0])) return false;
  const info = await lstat(file);
  if (info.mode & 0o111) return false;
  if (name.endsWith(".md")) {
    // require() can execute unknown extensions as JavaScript. Accept only a
    // Markdown heading/frontmatter prefix that native JS cannot parse, not a
    // filename alone. Other document formats conservatively force isolation.
    const handle = await open(file, "r");
    try {
      const prefix = Buffer.alloc(128);
      const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
      return /^(?:\uFEFF)?[ \t\r\n]*(?:#{1,6} |---\r?\n)/.test(prefix.subarray(0, bytesRead).toString("utf8"));
    } finally { await handle.close(); }
  }
  if (info.size > 4096) return false;
  // The SDD workflow writes these two inert markers alongside its Markdown.
  // Validate bytes as well as names; arbitrary extensionless files stay unknown.
  if (name === ".superpowers/sdd/.gitignore") return /^\*\n?$/.test(await readFile(file, "utf8"));
  if (/^\.superpowers\/sdd\/[^/]+\/plan-path$/.test(name)) {
    const marker = await readFile(file, "utf8");
    if (!/^(?:\/|(?:\.\.?\/)+)[A-Za-z0-9_./ -]+\.md\n?$/.test(marker)) return false;
    // Even absolute-looking paths can be JS regex/comment expressions. Compile
    // only this small metadata string, never execute it; ambiguous paths isolate.
    try { new Script(marker); return false; }
    catch (error) { return error instanceof SyntaxError; }
  }
  return false;
}
function gitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|PREFIX|QUARANTINE_PATH)$/i.test(key)) delete env[key];
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

export async function checkoutMatchesCommit(repo, commit) {
  try {
    const git = async args => (await run("git", ["-C", repo, ...args],
      { env: gitEnvironment(), maxBuffer: 64 * 1024 * 1024 })).stdout;
    const root = (await git(["rev-parse", "--show-toplevel"])).trim();
    const format = (await git(["rev-parse", "--show-object-format"])).trim();
    if (!["sha1", "sha256"].includes(format)) return false;
    if ((await git(["config", "--get", "core.sparseCheckout"]).catch(() => "")).trim() === "true") return false;
    const installed = await lstat(path.join(root, "node_modules")).catch(() => null);
    if (installed && !await testFingerprint(root)) return false;
    const tree = (await git(["rev-parse", `${commit}^{tree}`])).trim();
    if (tree !== (await git(["rev-parse", "HEAD^{tree}"])).trim()) return false;
    if ((await git(["status", "--porcelain=v1", "--untracked-files=all"])).length) return false;
    if ((await git(["ls-files", "-v", "-z"])).split("\0").some(line => /^[a-zS] /.test(line))) return false;
    const records = (await git(["ls-tree", "-r", "-z", commit])).split("\0").filter(Boolean);
    const known = new Set();
    const links = [];
    let next = 0;
    let matches = true;
    await Promise.all(Array.from({ length: Math.min(8, records.length) }, async () => {
      while (next < records.length) {
        const record = records[next++];
        const separator = record.indexOf("\t");
        const [mode, type, oid] = record.slice(0, separator).split(" ");
        const name = record.slice(separator + 1);
        if (separator < 0 || name.includes("\uFFFD") || type !== "blob") { matches = false; continue; }
        known.add(name);
        const file = path.join(root, name);
        const info = await lstat(file);
        let bytes;
        if (mode === "120000" && info.isSymbolicLink()) {
          bytes = await readlink(file, { encoding: "buffer" });
          links.push(file);
        }
        else if (info.isFile() && ["100644", "100755"].includes(mode)) {
          if (process.platform !== "win32" && (info.mode & 0o111 ? "100755" : "100644") !== mode) matches = false;
          bytes = await readFile(file);
        } else { matches = false; continue; }
        const actualOid = createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
        if (actualOid !== oid) matches = false;
      }
    }));
    // Link text is a blob, but executable target bytes must independently be
    // a known tracked regular file. Never follow unlisted files/directories.
    const canonicalRoot = await realpath(root);
    for (const link of links) {
      const target = await realpath(link);
      const name = path.relative(canonicalRoot, target).split(path.sep).join("/");
      if (!known.has(name) || !(await lstat(target)).isFile()) matches = false;
    }
    // Also inspect ignored input membership. Git's untracked list cannot see an
    // ignored test or nested dependency that the runner/imports can execute.
    const walk = async (directory, prefix = "") => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!prefix && [".git", "node_modules"].includes(entry.name)) continue;
        const name = `${prefix}${entry.name}`;
        if (entry.isDirectory()) await walk(path.join(directory, entry.name), `${name}/`);
        else if (!known.has(name)) {
          // Local planning Markdown is harmless documentation, but directory
          // names alone never exempt scripts, symlinks or executable files.
          const document = await harmlessAdministrativeFile(path.join(directory, entry.name), name, entry);
          if (!document) matches = false;
        }
        if (!matches) return;
      }
    };
    await walk(root);
    return matches;
  } catch { return false; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await checkoutMatchesCommit(process.cwd(), "HEAD") ? 0 : 1;
}
