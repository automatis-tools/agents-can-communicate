import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
const exec = promisify(execFile);
const installer = path.resolve("scripts/codex-indicator/install.mjs");
const posix = { skip: process.platform === "win32" };
const digest = data => createHash("sha256").update(data).digest("hex");

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "acc-codex-install-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "User's local $(false) `false` build");
  const binary = path.join(dir, "candidate");
  const stock = path.join(dir, "stock");
  const command = path.join(dir, "codex");
  const reader = path.join(dir, "ACC's reader.mjs");
  await writeFile(binary, `#!${process.execPath}\n
    if(process.argv[2]==='--version') console.log('codex-cli 0.162.1');
    else console.log(JSON.stringify({args:process.argv.slice(2),provider:JSON.parse(process.env.CODEX_STATUS_PROVIDER),cwd:process.cwd(),original:process.env.CODEX_STATUS_PROVIDER_ORIGINAL_CLI,fallback:JSON.parse(process.env.CODEX_STATUS_PROVIDER_FALLBACK ?? "null")}));\n`, { mode: 0o755 });
  await writeFile(stock, `#!${process.execPath}\nif(process.argv[2]==='--version') console.log('codex-cli 0.162.1'); else console.log(JSON.stringify({stock:true,args:process.argv.slice(2)}));\n`, { mode: 0o755 });
  await writeFile(reader, "console.log('{}');");
  await symlink("stock", command);
  const sha = digest(await readFile(binary));
  const install = (overrides = []) => exec(process.execPath, [installer, "install", "--root", root,
    "--binary", binary, "--sha256", sha, "--command", command, "--reader", reader, ...overrides]);
  const uninstall = () => exec(process.execPath, [installer, "uninstall", "--root", root]);
  return { dir, root, binary, stock, command, reader, install, uninstall };
}

test("local installation preserves arguments, reader identity, and restores the exact original link", posix, async t => {
  const f = await fixture(t);
  await f.install();
  const args = ["resume", "--last", "spaces ' $(false) `false`", "--no-alt-screen"];
  const result = JSON.parse((await exec(f.command, args, { cwd: f.dir })).stdout);
  assert.deepEqual(result.args, args);
  assert.deepEqual(result.provider, [process.execPath, path.join(f.root, "provider.mjs"), f.reader]);
  assert.equal(result.cwd, await realpath(f.dir));
  assert.equal(result.fallback?.spans.map(span => span.text).join(""), "ACC ! · acc doctor");
  assert.equal(digest(await readFile(path.join(f.root, "codex"))), digest(await readFile(f.binary)));
  const receipt = JSON.parse(await readFile(path.join(f.root, "installation.json")));
  assert.equal(receipt.previousLink, "stock");
  await f.install(); // Idempotent: must not replace the original rollback target.
  assert.equal(JSON.parse(await readFile(path.join(f.root, "installation.json"))).previousLink, "stock");
  const update = JSON.parse((await exec(f.command, ["-c", "model=example", "update"])).stdout);
  assert.deepEqual(update.args, ["-c", "model=example", "update"]);
  assert.equal(update.original, f.stock);
  await exec(path.join(f.root, "uninstall"));
  assert.equal(await readlink(f.command), "stock");
  await assert.rejects(lstat(f.root), { code: "ENOENT" });
});

test("a checksum mismatch cannot publish a launcher or alter the original command", posix, async t => {
  const f = await fixture(t);
  await assert.rejects(f.install(["--sha256", "0".repeat(64)]), /checksum/i);
  assert.equal(await readlink(f.command), "stock");
  await assert.rejects(lstat(f.root), { code: "ENOENT" });
});

test("the installer refuses a user wrapper and an occupied installation directory", posix, async t => {
  const f = await fixture(t);
  await rm(f.command);
  await writeFile(f.command, "user wrapper");
  await assert.rejects(f.install(), /symbolic link/i);
  assert.equal(await readFile(f.command, "utf8"), "user wrapper");
  await rm(f.command);
  await symlink("stock", f.command);
  await mkdir(f.root);
  await writeFile(path.join(f.root, "user-file"), "keep");
  await assert.rejects(f.install(), /exists|occupied/i);
  assert.equal(await readFile(path.join(f.root, "user-file"), "utf8"), "keep");
  assert.equal(await readlink(f.command), "stock");
});

test("uninstall never overwrites a later user command or deletes unknown local files", posix, async t => {
  const f = await fixture(t);
  await f.install();
  const owned = await readlink(f.command);
  await rm(f.command);
  await writeFile(f.command, "new user command");
  await assert.rejects(f.uninstall(), /changed/i);
  assert.equal(await readFile(f.command, "utf8"), "new user command");
  await rm(f.command);
  await symlink(owned, f.command);
  await writeFile(path.join(f.root, "user-file"), "keep");
  await f.uninstall();
  assert.equal(await readlink(f.command), "stock");
  assert.equal(await readFile(path.join(f.root, "user-file"), "utf8"), "keep");
});

test("a staging failure removes only its own partial installation and leaves Codex usable", posix, async t => {
  const f = await fixture(t);
  const incomplete = path.join(f.dir, "install-alone.mjs");
  await writeFile(incomplete, await readFile(installer));
  await assert.rejects(exec(process.execPath, [incomplete, "install", "--root", f.root,
    "--binary", f.binary, "--sha256", digest(await readFile(f.binary)), "--command", f.command,
    "--reader", f.reader]), /ENOENT/);
  assert.equal(await readlink(f.command), "stock");
  await assert.rejects(lstat(f.root), { code: "ENOENT" });
  assert.equal(JSON.parse((await exec(f.command)).stdout).stock, true);
});

test("rollback preserves an installed file that the user edited", posix, async t => {
  const f = await fixture(t);
  await f.install();
  const provider = path.join(f.root, "provider.mjs");
  await writeFile(provider, "// user changed this file\n");
  await assert.rejects(f.install(), /changed/i);
  const result = JSON.parse((await f.uninstall()).stdout);
  assert.deepEqual(result.preserved, [provider]);
  assert.equal(await readFile(provider, "utf8"), "// user changed this file\n");
  assert.equal(await readlink(f.command), "stock");
});


test("a newer original Codex is not silently replaced with an older local build", posix, async t => {
  const f = await fixture(t);
  await writeFile(f.stock, `#!${process.execPath}\nconsole.log('codex-cli 0.163.0');\n`, { mode: 0o755 });
  await assert.rejects(f.install(), /original.*version/i);
  assert.equal(await readlink(f.command), "stock");
  await assert.rejects(lstat(f.root), { code: "ENOENT" });
});
