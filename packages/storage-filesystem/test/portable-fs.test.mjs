import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openNoFollow, removeTree, renameEntry, renameReplacing, syncEntry }
  from "../src/portable-fs.mjs";

// Each Windows rule below was measured on a windows-latest runner (see
// docs/design/2026-09-30-native-windows-support.md). The fakes replay those
// error codes so the Windows branch runs on every host, and the real-disk
// cases at the end run whatever the host is.
const failing = (code, times, then = async () => {}) => {
  let calls = 0;
  const operation = async (...args) => {
    calls += 1;
    if (calls <= times) throw Object.assign(new Error(code), { code });
    return then(...args);
  };
  operation.calls = () => calls;
  return operation;
};
const noSleep = async () => {};
const later = () => Date.now() + 60_000;

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-portable-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("windows: a rename over a file some reader holds is retried until it lands", async () => {
  const rename = failing("EPERM", 3);
  await renameReplacing("a", "b", { platform: "win32", rename, sleep: noSleep,
    deadlineAt: later() });
  assert.equal(rename.calls(), 4);
});

test("windows: a busy rename that outlasts the deadline reports the busy error", async () => {
  const rename = failing("EBUSY", Number.POSITIVE_INFINITY);
  await assert.rejects(renameReplacing("a", "b", { platform: "win32", rename, sleep: noSleep,
    deadlineAt: Date.now() - 1 }), { code: "EBUSY" });
});

test("posix: a failed rename over a file is reported at once", async () => {
  const rename = failing("EPERM", 1);
  await assert.rejects(renameReplacing("a", "b", { platform: "linux", rename, sleep: noSleep,
    deadlineAt: later() }), { code: "EPERM" });
  assert.equal(rename.calls(), 1);
});

test("windows: a directory renamed onto an existing name reports EEXIST, as POSIX does", async () => {
  const rename = failing("EPERM", Number.POSITIVE_INFINITY);
  const lstat = async () => ({ isDirectory: () => true });
  await assert.rejects(renameEntry("candidate", "writer.lock", { platform: "win32", rename,
    lstat, sleep: noSleep, deadlineAt: later() }), { code: "EEXIST" });
  assert.equal(rename.calls(), 1);
});

test("windows: a directory rename refused by an open file inside is retried", async () => {
  const rename = failing("EPERM", 2);
  const lstat = async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
  await renameEntry("writer.lock", "writer.released.lock", { platform: "win32", rename,
    lstat, sleep: noSleep, deadlineAt: later() });
  assert.equal(rename.calls(), 3);
});

test("windows: a file symlink is refused although the open itself would follow it", async () => {
  const lstat = async () => ({ isSymbolicLink: () => true });
  const opened = [];
  await assert.rejects(openNoFollow("record.json", 0, { platform: "win32", lstat,
    open: async (...args) => { opened.push(args); } }), { code: "ELOOP" });
  assert.deepEqual(opened, []);
});

test("windows: a name swapped between the check and the open is refused", async () => {
  const lstat = async () => ({ isSymbolicLink: () => false, dev: 1n, ino: 7n });
  let closed = false;
  const handle = { stat: async () => ({ dev: 1n, ino: 8n }), close: async () => { closed = true; } };
  await assert.rejects(openNoFollow("record.json", 0, { platform: "win32", lstat,
    open: async () => handle }), { code: "ELOOP" });
  assert.equal(closed, true);
});

test("windows: an open refused by a scanner without read sharing is retried", async () => {
  const lstat = async () => ({ isSymbolicLink: () => false, dev: 1n, ino: 7n });
  const handle = { stat: async () => ({ dev: 1n, ino: 7n }), close: async () => {} };
  const openFile = failing("EBUSY", 2, async () => handle);
  assert.equal(await openNoFollow("record.json", 0, { platform: "win32", lstat, open: openFile,
    sleep: noSleep, deadlineAt: later() }), handle);
  assert.equal(openFile.calls(), 3);
});

test("windows: a file that does not exist yet is created, then checked", async () => {
  let created = false;
  const lstat = async () => {
    if (!created) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return { isSymbolicLink: () => false, dev: 1n, ino: 9n };
  };
  const handle = { stat: async () => ({ dev: 1n, ino: 9n }), close: async () => {} };
  assert.equal(await openNoFollow("new.json", 0, { platform: "win32", lstat,
    open: async () => { created = true; return handle; } }), handle);
});

test("windows: a directory is never opened for a flush; a published file is", async () => {
  const opened = [];
  const open = async (target, flags) => {
    opened.push([target, flags]);
    return { sync: async () => {}, close: async () => {} };
  };
  await syncEntry("locks", "locks\\writer.lock", { platform: "win32", open,
    lstat: async () => ({ isDirectory: () => true }) });
  assert.deepEqual(opened, []);
  await syncEntry("state", "state\\a.json", { platform: "win32", open,
    lstat: async () => ({ isDirectory: () => false }) });
  assert.deepEqual(opened, [["state\\a.json", "r+"]]);
});

test("posix: the directory holding the entry is synced", async () => {
  const opened = [];
  const open = async (target, flags) => {
    opened.push([target, flags]);
    return { sync: async () => {}, close: async () => {} };
  };
  await syncEntry("state", "state/a.json", { platform: "darwin", open });
  assert.equal(opened.length, 1);
  assert.equal(opened[0][0], "state");
});

test("windows: a tree still in use is removed with retries", async () => {
  const calls = [];
  await removeTree("generation", { platform: "win32", rm: async (...args) => { calls.push(args); } });
  assert.equal(calls[0][1].maxRetries > 0, true);
  await removeTree("generation", { platform: "linux", rm: async (...args) => { calls.push(args); } });
  assert.equal(calls[1][1].maxRetries, 0);
});

test("this host: a rename replaces a file a reader holds open", async t => {
  const root = await fixture(t);
  const target = path.join(root, "state.json");
  const next = path.join(root, "next.json");
  await writeFile(target, "old");
  await writeFile(next, "new");
  const reader = await open(target, "r");
  setTimeout(() => { reader.close(); }, 50);
  await renameReplacing(next, target, { deadlineAt: later() });
  assert.equal(await readFile(target, "utf8"), "new");
});

test("this host: a symlinked record is refused", async t => {
  const root = await fixture(t);
  const real = path.join(root, "real.json");
  const link = path.join(root, "link.json");
  await writeFile(real, "{}");
  try {
    await symlink(real, link, "file");
  } catch (error) {
    // Creating a symlink needs Developer Mode or an elevated token on Windows.
    if (error.code === "EPERM") { t.skip("this account may not create symlinks"); return; }
    throw error;
  }
  await assert.rejects(openNoFollow(link, 0), { code: "ELOOP" });
  const handle = await openNoFollow(real, 0);
  await handle.close();
});

test("this host: a directory rename onto an existing directory reports EEXIST or ENOTEMPTY", async t => {
  const root = await fixture(t);
  const from = path.join(root, "candidate");
  const to = path.join(root, "writer.lock");
  await mkdir(from);
  await writeFile(path.join(from, "owner.json"), "{}");
  await mkdir(to);
  await writeFile(path.join(to, "owner.json"), "{}");
  await assert.rejects(renameEntry(from, to, { deadlineAt: later() }),
    error => ["EEXIST", "ENOTEMPTY"].includes(error.code));
});

// Measured on windows-latest: opening a file in a directory another process is
// removing fails EPERM, and the name is gone right after. That is the file
// being absent, as ENOENT says on Linux. A file that is still there keeps EPERM.
test("windows: an open refused because the name is being deleted reads as absent", async () => {
  let deleted = false;
  const lstat = async () => {
    if (deleted) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return { isSymbolicLink: () => false, dev: 1n, ino: 7n };
  };
  const open = async () => {
    deleted = true;
    throw Object.assign(new Error("EPERM: operation not permitted, open"), { code: "EPERM" });
  };
  await assert.rejects(openNoFollow("owner.json", 0, { platform: "win32", lstat, open }),
    error => error.code === "ENOENT" && error.cause?.code === "EPERM");

  const present = async () => ({ isSymbolicLink: () => false, dev: 1n, ino: 7n });
  await assert.rejects(openNoFollow("owner.json", 0, { platform: "win32", lstat: present, open }),
    { code: "EPERM" });
});
