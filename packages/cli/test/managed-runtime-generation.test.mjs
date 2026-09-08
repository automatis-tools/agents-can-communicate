import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { stageOwnGeneration } from "../src/managed-runtime/generation.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "acc-generation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "source"), managerRoot = path.join(root, "manager");
  const manifest = { name: "agents-can-communicate", version: "0.4.0", files: ["bin/"],
    bundleDependencies: ["@agents-can-communicate/example"] };
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify(manifest));
  await writeFile(path.join(packageRoot, "bin", "acc.mjs"), "console.log('version A');\n");
  await writeFile(path.join(packageRoot, "dev-secret.txt"), "never copy me");
  const dependency = path.join(root, "workspace");
  await mkdir(path.join(dependency, "src"), { recursive: true });
  await writeFile(path.join(dependency, "package.json"), JSON.stringify({
    name: "@agents-can-communicate/example", version: "0.4.0", files: ["src/"] }));
  await writeFile(path.join(dependency, "src", "index.mjs"), "export const value = 17;\n");
  await writeFile(path.join(dependency, "test-secret.txt"), "never copy this either");
  await mkdir(path.join(packageRoot, "node_modules", "@agents-can-communicate"), { recursive: true });
  await symlink(dependency, path.join(packageRoot, "node_modules", "@agents-can-communicate", "example"));
  return { root, packageRoot, managerRoot, manifest };
}

test("managed generation contains runnable declared files and bundled workspace bytes only", async t => {
  const f = await fixture(t);
  const first = await stageOwnGeneration(f);
  assert.equal(first.version, "0.4.0");
  assert.equal(await readFile(path.join(first.root, "bin", "acc.mjs"), "utf8"), "console.log('version A');\n");
  assert.equal(await readFile(path.join(first.root, "node_modules", "@agents-can-communicate", "example", "src", "index.mjs"), "utf8"), "export const value = 17;\n");
  const files = await readdir(first.root, { recursive: true });
  assert.equal(files.some(file => file.includes("secret")), false);
  await rm(f.packageRoot, { recursive: true });
  assert.equal(await readFile(path.join(first.root, "bin", "acc.mjs"), "utf8"), "console.log('version A');\n");
});

test("staging a new build never overwrites an existing generation and detects tampering", async t => {
  const f = await fixture(t);
  const first = await stageOwnGeneration(f);
  assert.deepEqual(await stageOwnGeneration(f), first);
  await writeFile(path.join(f.packageRoot, "bin", "acc.mjs"), "console.log('version B');\n");
  const second = await stageOwnGeneration(f);
  assert.notEqual(second.root, first.root);
  assert.equal(await readFile(path.join(first.root, "bin", "acc.mjs"), "utf8"), "console.log('version A');\n");
  await writeFile(path.join(second.root, "bin", "acc.mjs"), "tampered");
  await assert.rejects(stageOwnGeneration(f), /changed|integrity|corrupt/i);
});

test("generation staging refuses escaping declarations and symlinks inside shipped trees", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.packageRoot, "package.json"), JSON.stringify({ ...f.manifest, files: ["../outside"] }));
  await assert.rejects(stageOwnGeneration(f), /path|declared/i);
  await writeFile(path.join(f.packageRoot, "package.json"), JSON.stringify(f.manifest));
  await symlink(path.join(f.root, "outside"), path.join(f.packageRoot, "bin", "escape.mjs"));
  await assert.rejects(stageOwnGeneration(f), /symbolic|symlink/i);
});

test("generation reuse preserves executable modes under a private installation umask", async t => {
  const f = await fixture(t);
  let first;
  const previous = process.umask(0o077);
  try { first = await stageOwnGeneration(f); }
  finally { process.umask(previous); }
  assert.deepEqual(await stageOwnGeneration(f), first);
});

test("a symlinked parent cannot put runtime state inside the source package", async t => {
  const f = await fixture(t);
  const alias = path.join(f.root, "alias");
  await symlink(f.packageRoot, alias);
  await assert.rejects(stageOwnGeneration({ ...f, managerRoot: path.join(alias, "runtime") }), /outside/);
  assert.equal((await readdir(f.packageRoot)).includes("runtime"), false);
});

test("declared file cannot traverse an intermediate symbolic link", async t => {
  const f = await fixture(t);
  await symlink(path.join(f.root, "workspace", "src"), path.join(f.packageRoot, "linked"));
  await writeFile(path.join(f.packageRoot, "package.json"), JSON.stringify({ ...f.manifest, files: ["linked/index.mjs"] }));
  await assert.rejects(stageOwnGeneration(f), /symbolic|symlink/i);
  assert.equal((await readdir(f.root)).includes("manager"), false);
});

test("runtime state cannot be created inside a resolved bundled workspace", async t => {
  const f = await fixture(t);
  const workspace = path.join(f.root, "workspace", "src");
  await assert.rejects(stageOwnGeneration({ ...f, managerRoot: path.join(workspace, "runtime") }), /outside/);
  assert.equal((await readdir(workspace)).includes("runtime"), false);
});

test("the top-level manifest is checked before following or parsing a symbolic link", async t => {
  const f = await fixture(t);
  const manifest = path.join(f.packageRoot, "package.json");
  await rm(manifest);
  const outside = path.join(f.root, "outside.json");
  await writeFile(outside, "not JSON");
  await symlink(outside, manifest);
  await assert.rejects(stageOwnGeneration(f), /symbolic|symlink/i);
  assert.equal((await readdir(f.root)).includes("manager"), false);
});
