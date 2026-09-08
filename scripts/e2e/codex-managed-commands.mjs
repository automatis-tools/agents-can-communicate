// A managed command is valid evidence only when its active generation and
// immutable launcher modules are byte-identical to the isolated npm artifact.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

async function files(root, relative = "", found = new Map()) {
  const file = path.join(root, relative);
  const info = await lstat(file);
  assert.equal(info.isSymbolicLink(), false, "generation must not contain symlinks");
  if (info.isDirectory()) {
    for (const name of await readdir(file)) await files(root, path.join(relative, name), found);
  } else {
    assert.equal(info.isFile(), true, "generation must contain regular files");
    found.set(relative, await readFile(file));
  }
  return found;
}

async function declaredFiles(packageRoot, prefix = "", found = new Map()) {
  const directory = path.join(packageRoot, prefix);
  const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  const names = new Set(["package.json", ...manifest.files,
    ...(await readdir(directory)).filter(name => /^(readme|licen[cs]e)(\..*)?$/i.test(name))]);
  for (const name of names) {
    assert.ok(!path.isAbsolute(name) && !name.split(/[\\/]/).includes(".."));
    await files(packageRoot, path.join(prefix, name), found);
  }
  if (prefix === "") for (const name of manifest.bundleDependencies) {
    assert.match(name, /^@agents-can-communicate\/[a-z0-9-]+$/);
    await declaredFiles(packageRoot, path.join("node_modules", name), found);
  }
  return found;
}

export async function verifyManagedCommands({ packageRoot, dataHome }) {
  packageRoot = await realpath(packageRoot);
  const root = await realpath(path.join(dataHome, "acc", "runtime"));
  const control = JSON.parse(await readFile(path.join(root, "control.json"), "utf8"));
  assert.equal(control.phase, "ready", "managed installation must be ready");
  const active = await realpath(control.active.root);
  assert.equal(path.dirname(active), path.join(root, "generations"), "generation must be owned by this manager");
  const expected = await declaredFiles(packageRoot);
  const actual = await files(active);
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), "generation file set differs");
  for (const [name, bytes] of expected) {
    assert.ok(actual.get(name).equals(bytes), `generation bytes differ: ${name}`);
  }
  const modules = new Map();
  const hash = createHash("sha256");
  for (const name of ["entry.mjs", "state.mjs", "mutex.mjs", "leases.mjs", "schedule.mjs", "policy.mjs"]) {
    const bytes = await readFile(path.join(packageRoot, "node_modules", "@agents-can-communicate",
      "cli", "src", "managed-runtime", name));
    modules.set(name, bytes); hash.update(name).update(bytes);
  }
  const id = hash.digest("hex");
  const launcherRoot = path.join(root, "launchers", id);
  const installedModules = await files(launcherRoot);
  assert.deepEqual([...installedModules.keys()].sort(), [...modules.keys()].sort(), "launcher module set differs");
  for (const [name, bytes] of modules) {
    assert.ok(installedModules.get(name).equals(bytes), `launcher module bytes differ: ${name}`);
  }
  const targets = {};
  for (const kind of ["acc", "acc-hook"]) {
    const target = path.join(root, "bin", `${kind}.mjs`);
    assert.equal(await realpath(target), target, "launcher must not redirect");
    const expected = `#!/usr/bin/env node\nimport { runEntry } from "../launchers/${id}/entry.mjs";\n`
      + `await runEntry(${JSON.stringify({ kind, packageRoot: active, managerRoot: root, managedRequired: true })});\n`;
    assert.equal(await readFile(target, "utf8"), expected, "launcher bytes differ");
    targets[kind] = target;
  }
  return targets;
}
