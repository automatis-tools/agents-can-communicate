import assert from "node:assert/strict";
import { lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

/** Capture the newly allocated root before any clients run. Never delete a replacement. */
export async function ownMigrationCleanup(root, ownedPids, {
  remove = rm, attempts = 8, retryDelayMs = 100,
} = {}) {
  assert.match(path.basename(root), /^acc-legacy-migration-[A-Za-z0-9]+$/);
  assert.equal(await realpath(root), root, "migration root must be canonical");
  const identity = await lstat(root);
  assert.ok(identity.isDirectory() && !identity.isSymbolicLink());
  return async () => {
    for (const pid of ownedPids) assert.equal(alive(pid), false, "owned migration daemon is still alive");
    for (let attempt = 0; attempt < attempts; attempt++) {
      const current = await lstat(root).catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (current === null) return;
      assert.ok(current.isDirectory() && !current.isSymbolicLink()
        && current.dev === identity.dev && current.ino === identity.ino,
      "migration root identity changed; refusing cleanup");
      try { await remove(root, { recursive: true, force: true }); }
      catch (error) {
        if (error.code !== "ENOTEMPTY" || attempt + 1 === attempts) throw error;
      }
      const remains = await lstat(root).catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (remains === null) return;
      if (attempt + 1 === attempts) throw new Error("migration root remains after bounded cleanup");
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
  };
}
