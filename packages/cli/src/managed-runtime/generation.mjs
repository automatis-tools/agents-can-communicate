import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm }
  from "node:fs/promises";
import path from "node:path";

import { attachStagingTemp, holdStagedGeneration, releaseStagingHold } from "./staging.mjs";

const NAME = "agents-can-communicate";
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

async function canonicalFuturePath(file) {
  let current = path.resolve(file);
  const trailing = [];
  for (;;) {
    try { return path.join(await realpath(current), ...trailing); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      trailing.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function directory(file) {
  await mkdir(file, { recursive: true, mode: 0o700 });
  const stat = await lstat(file);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("managed runtime directory is not a regular directory");
}

function declaredPath(value) {
  if (typeof value !== "string" || value === "" || /[\\*?\[\]{}\0]/.test(value)
    || path.isAbsolute(value) || value.split("/").includes("..")) {
    throw new Error("invalid declared runtime path");
  }
  return value.replace(/\/+$/, "");
}

async function collectFile(source, relative, collected) {
  const stat = await lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`symbolic link inside runtime files: ${relative}`);
  if (stat.isDirectory()) {
    for (const entry of (await readdir(source)).sort()) {
      await collectFile(path.join(source, entry), path.posix.join(relative, entry), collected);
    }
  } else if (stat.isFile()) {
    collected.set(relative, { bytes: await readFile(source), mode: stat.mode & 0o777 });
  } else throw new Error(`unsupported runtime file: ${relative}`);
}

async function checkDeclaredComponents(source, relative) {
  let current = source;
  for (const component of relative.split("/")) {
    current = path.join(current, component);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error(`symbolic link inside declared runtime path: ${relative}`);
    }
  }
}

function requireOutside(source, root) {
  const relative = path.relative(source, root);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("managed runtime must live outside its source package");
  }
}

async function collectPackage(source, prefix, collected, expectedName, version) {
  await checkDeclaredComponents(source, "package.json");
  const manifestFile = path.join(source, "package.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  if (manifest.name !== expectedName || manifest.version !== version
    || !Array.isArray(manifest.files)) throw new Error("runtime package identity or declared files are invalid");
  const declared = new Set(["package.json", ...manifest.files.map(declaredPath)]);
  // npm includes these public package files regardless of the files whitelist.
  for (const file of await readdir(source)) {
    if (/^(readme|licen[cs]e)(\..*)?$/i.test(file)) declared.add(file);
  }
  for (const relative of declared) {
    await checkDeclaredComponents(source, relative);
    await collectFile(path.join(source, relative), path.posix.join(prefix, relative), collected);
  }
  return manifest;
}

function fingerprint(files) {
  const hash = createHash("sha256");
  for (const [name, file] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(JSON.stringify([name, file.mode, file.bytes.length]));
    hash.update(file.bytes);
  }
  return hash.digest("hex");
}

async function existingMatches(target, files) {
  try {
    const actual = new Map();
    await collectFile(target, "", actual);
    if (fingerprint(actual) !== fingerprint(files)) throw new Error("managed runtime generation integrity changed");
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      // Only an absent generation is new. A damaged existing tree is not a
      // staging directory we are entitled to overwrite.
      const exists = await lstat(target).then(() => true, e => {
        if (e.code === "ENOENT") return false;
        throw e;
      });
      if (!exists) return false;
    }
    throw error;
  }
}

/** Materialize the package's shipped files; never copy a checkout or workspace symlink. */
export async function stageOwnGeneration({ packageRoot, managerRoot }) {
  const source = await realpath(packageRoot);
  const root = await canonicalFuturePath(managerRoot);
  requireOutside(source, root);
  await checkDeclaredComponents(source, "package.json");
  const manifest = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
  if (manifest.name !== NAME || !STABLE.test(manifest.version)) throw new Error("invalid ACC runtime version");
  const files = new Map();
  await collectPackage(source, "", files, NAME, manifest.version);
  if (!Array.isArray(manifest.bundleDependencies)) throw new Error("runtime must declare its bundled workspaces");
  for (const name of manifest.bundleDependencies) {
    if (!/^@agents-can-communicate\/[a-z0-9-]+$/.test(name)) throw new Error("invalid bundled runtime package");
    const location = await realpath(path.join(source, "node_modules", name));
    requireOutside(location, root);
    await collectPackage(location, `node_modules/${name}`, files, name, manifest.version);
  }
  const digest = fingerprint(files);
  await directory(root);
  const generations = path.join(root, "generations");
  await directory(generations);
  const target = path.join(generations, `${manifest.version}-${digest.slice(0, 24)}`);
  const result = { version: manifest.version, root: target, digest };
  // Held before the check that may return `target` unchanged (it can already
  // be sitting on disk unprotected from an earlier run) and, on the staging
  // path below, before the rename that makes a freshly built `target`
  // visible at all: reclaim must never observe the directory without also
  // observing why it exists. The caller now owns this hold - see its own
  // `hold` on the returned value - and must release it on every exit from
  // its own attempt, once the generation is either published or abandoned.
  // A hold this function itself never hands off (because it throws instead
  // of returning) is released here, in its own catch, rather than left for
  // a confirmed-dead reap to eventually find.
  const hold = await holdStagedGeneration({ root, generationRoot: target });
  try {
    if (await existingMatches(target, files)) return { ...result, hold };
    const staging = await mkdtemp(path.join(generations, ".staging-"));
    try {
      await attachStagingTemp(hold, staging);
      const directories = new Set([staging]);
      for (const [name, file] of files) {
        const destination = path.join(staging, name);
        await mkdir(path.dirname(destination), { recursive: true });
        for (let parent = path.dirname(destination); parent !== staging; parent = path.dirname(parent)) directories.add(parent);
        const handle = await open(destination, "wx", file.mode);
        try {
          await handle.writeFile(file.bytes);
          await handle.chmod(file.mode);
          await handle.sync();
        } finally { await handle.close(); }
      }
      for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
        const handle = await open(directory, "r");
        try { await handle.sync(); } finally { await handle.close(); }
      }
      try {
        await rename(staging, target);
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes(error.code) || !await existingMatches(target, files)) throw error;
      }
      const handle = await open(generations, "r");
      try { await handle.sync(); } finally { await handle.close(); }
      return { ...result, hold };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  } catch (error) {
    await releaseStagingHold(hold);
    throw error;
  }
}
