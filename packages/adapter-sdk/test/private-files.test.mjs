import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { closedTo, openRegularNoFollow } from "../src/private-files.mjs";

test("POSIX mode bits decide privacy; Windows, which has none, leaves it to the profile ACL", () => {
  assert.equal(closedTo({ mode: 0o100600 }, 0o077, { platform: "linux" }), true);
  assert.equal(closedTo({ mode: 0o100644 }, 0o077, { platform: "linux" }), false);
  assert.equal(closedTo({ mode: 0o100666 }, 0o077, { platform: "win32" }), true);
});

test("windows: a regular file opens; a link or a directory at the name does not", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-private-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "record.json");
  await writeFile(file, "{}");
  const handle = await openRegularNoFollow(file, undefined, { platform: "win32" });
  assert.equal(String(await handle.readFile("utf8")), "{}");
  await handle.close();

  await mkdir(path.join(root, "dir"));
  await assert.rejects(openRegularNoFollow(path.join(root, "dir"), undefined, { platform: "win32" }),
    { code: "EINVAL" });
  try {
    await symlink(file, path.join(root, "link.json"));
  } catch (error) {
    if (error.code === "EPERM") { t.skip("this account may not create symlinks"); return; }
    throw error;
  }
  await assert.rejects(openRegularNoFollow(path.join(root, "link.json"), undefined, { platform: "win32" }),
    { code: "EINVAL" });
});
