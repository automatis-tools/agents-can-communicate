import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, symlink, writeFile }
  from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ownMigrationCleanup } from "../../scripts/e2e/codex-migration-cleanup.mjs";
const run = promisify(execFile);
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-legacy-migration-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("migration cleanup retries a real ENOTEMPTY from a late plugin writer", async t => {
  const root = await fixture(t);
  const plugins = path.join(root, "codex", ".tmp", "plugins-clone-test", "plugins");
  await mkdir(plugins, { recursive: true });
  let calls = 0;
  const cleanup = await ownMigrationCleanup(root, [], { retryDelayMs: 1,
    remove: async (target, options) => {
      if (++calls === 1) {
        await run(process.execPath, ["--input-type=module", "--eval",
          'import {writeFile} from "node:fs/promises"; await writeFile(process.argv[1], "late plugin bytes");',
          path.join(plugins, "late-plugin")]);
        await rmdir(plugins); // Real filesystem ENOTEMPTY after the writer exits.
      }
      return rm(target, options);
    } });
  await cleanup();
  assert.equal(calls, 2);
  await assert.rejects(lstat(root), { code: "ENOENT" });
});

test("migration cleanup rejects persistent ENOTEMPTY after its finite retry budget", async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, "kept"), "owned bytes");
  let calls = 0;
  const cleanup = await ownMigrationCleanup(root, [], { attempts: 3, retryDelayMs: 1,
    remove: target => { calls++; return rmdir(target); } });
  await assert.rejects(cleanup, { code: "ENOTEMPTY" });
  assert.equal(calls, 3);
  assert.equal(await readFile(path.join(root, "kept"), "utf8"), "owned bytes");
});

test("migration cleanup refuses a still-living owned daemon", async t => {
  const root = await fixture(t);
  const cleanup = await ownMigrationCleanup(root, [process.pid]);
  await assert.rejects(cleanup, /daemon is still alive/);
  assert.ok((await lstat(root)).isDirectory());
});

test("migration cleanup refuses a replacement root and preserves its bytes", async t => {
  const root = await fixture(t);
  const cleanup = await ownMigrationCleanup(root, []);
  const retained = `${root}-retained`;
  t.after(() => rm(retained, { recursive: true, force: true }));
  await rename(root, retained);
  await mkdir(root);
  await writeFile(path.join(root, "unowned"), "preserve");
  await assert.rejects(cleanup, /identity changed/);
  assert.equal(await readFile(path.join(root, "unowned"), "utf8"), "preserve");
  await rm(root, { recursive: true });
  await symlink(retained, root);
  await assert.rejects(cleanup, /identity changed/);
  assert.ok((await lstat(retained)).isDirectory());
});

test("migration cleanup does not suppress unrelated removal errors or claim retained roots removed", async t => {
  const root = await fixture(t);
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const cleanup = await ownMigrationCleanup(root, [], { remove: async () => { throw denied; } });
  await assert.rejects(cleanup, error => error === denied);
  const noop = await ownMigrationCleanup(root, [], { attempts: 2, retryDelayMs: 1, remove: async () => {} });
  await assert.rejects(noop, /remains after bounded cleanup/);
});
