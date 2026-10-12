#!/usr/bin/env node
// A successful working-tree suite may certify only the exact pushed tree.
// Read blobs directly instead of trusting Git's stat/fsmonitor shortcuts.
// Filtered, sparse, submodule or otherwise uncertain checkouts simply rerun.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
try {
  const git = async args => (await run("git", args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
  const root = (await git(["rev-parse", "--show-toplevel"])).trim();
  const format = (await git(["rev-parse", "--show-object-format"])).trim();
  if (!["sha1", "sha256"].includes(format)) throw new Error("unknown object format");
  const records = (await git(["ls-tree", "-r", "-z", "HEAD"])).split("\0").filter(Boolean);
  let next = 0;
  let matches = true;
  await Promise.all(Array.from({ length: Math.min(8, records.length) }, async () => {
    while (next < records.length) {
      const record = records[next++];
      const separator = record.indexOf("\t");
      const [mode, type, oid] = record.slice(0, separator).split(" ");
      const name = record.slice(separator + 1);
      if (separator < 0 || name.includes("\uFFFD") || type !== "blob") {
        matches = false;
        continue;
      }
      const file = path.join(root, name);
      const info = await lstat(file);
      let bytes;
      if (mode === "120000" && info.isSymbolicLink()) bytes = await readlink(file, { encoding: "buffer" });
      else if (info.isFile() && ["100644", "100755"].includes(mode)) {
        const actualMode = info.mode & 0o111 ? "100755" : "100644";
        if (actualMode !== mode) matches = false;
        bytes = await readFile(file);
      } else {
        matches = false;
        continue;
      }
      const actualOid = createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      if (actualOid !== oid) matches = false;
    }
  }));
  process.exitCode = matches ? 0 : 1;
} catch { process.exitCode = 1; }
