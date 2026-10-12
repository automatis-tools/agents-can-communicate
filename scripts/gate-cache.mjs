// Success receipts are disposable local acceleration, never evidence for CI.
// Missing, expired, damaged or uncertain state always means run the real gate.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const VERSION = 1;
const MAX_AGE = 24 * 60 * 60 * 1000;
const directory = path.join(tmpdir(), `acc-development-gates-${process.getuid?.() ?? "user"}`);
const excludedEnv = new Set(["PWD", "OLDPWD", "SHLVL", "_", "GIT_DIR", "GIT_WORK_TREE",
  "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX", "GIT_QUARANTINE_PATH"]);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const inside = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);
const envName = name => process.platform === "win32" ? name.toUpperCase() : name;

function normalizedEnv(env, defaultGitExecPath) {
  return Object.entries(env).filter(([name, value]) => value !== undefined
    && !excludedEnv.has(envName(name))
    && !(envName(name) === "GIT_EXEC_PATH" && value === defaultGitExecPath))
    .map(([name, value]) => [envName(name), String(value)])
    .sort(([a], [b]) => a.localeCompare(b));
}

async function gitExecutable(env) {
  const pathKey = Object.keys(env).find(name => name === "PATH"
    || process.platform === "win32" && name.toUpperCase() === "PATH");
  if (!pathKey || !env[pathKey]) return null;
  const names = process.platform === "win32" ? ["git.exe", "git.com"] : ["git"];
  for (const entry of env[pathKey].split(path.delimiter)) {
    for (const name of names) {
      const file = path.resolve(entry || ".", name);
      try {
        await access(file, constants.X_OK);
        return await realpath(file);
      } catch { /* Keep searching just as process execution does. */ }
    }
  }
  return null;
}

async function testEnvironment(env, defaultGitExecPath) {
  const source = { ...env };
  const execKey = Object.keys(env).find(name => envName(name) === "GIT_EXEC_PATH");
  const pathKey = Object.keys(env).find(name => name === "PATH"
    || process.platform === "win32" && name.toUpperCase() === "PATH");
  if (execKey && env[execKey] === defaultGitExecPath && env[pathKey]) {
    // npm inserts its own prefixes ahead of Git's extra segment. Remove exactly
    // one default segment, and only when Git command precedence stays the same.
    const entries = env[pathKey].split(path.delimiter);
    const index = entries.indexOf(defaultGitExecPath);
    if (index !== -1) {
      entries.splice(index, 1);
      const candidate = { ...env, [pathKey]: entries.join(path.delimiter) };
      const [before, after] = await Promise.all([gitExecutable(env), gitExecutable(candidate)]);
      if (before && before === after) source[pathKey] = candidate[pathKey];
    }
  }
  return normalizedEnv(source, defaultGitExecPath);
}

async function runtime(observations) {
  const executable = await realpath(process.execPath);
  return [executable, await fileIdentity(executable, observations), process.version, process.platform,
    process.arch, process.execArgv];
}

function stable(before, after) {
  return ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"]
    .every(name => before[name] === after[name]);
}

function observe(file, info, observations) {
  observations?.push([file, ...["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"]
    .map(name => String(info[name]))]);
}

async function fileIdentity(file, observations) {
  const before = await lstat(file, { bigint: true });
  observe(file, before, observations);
  let identity;
  if (before.isSymbolicLink()) {
    const target = await readlink(file);
    const resolved = await realpath(file);
    // Directory links can introduce an unlisted dependency tree: no receipt.
    const targetBefore = await lstat(resolved, { bigint: true });
    observe(resolved, targetBefore, observations);
    if (!targetBefore.isFile()) throw new Error("unlisted symlink directory");
    identity = [Number(before.mode), target, resolved, Number(targetBefore.mode), digest(await readFile(resolved))];
    if (!stable(targetBefore, await lstat(resolved, { bigint: true }))) throw new Error("changed link target");
  } else if (before.isFile()) identity = [Number(before.mode), digest(await readFile(file))];
  else throw new Error("input is not a regular file");
  if (!stable(before, await lstat(file, { bigint: true }))) throw new Error("changed input");
  return identity;
}

// Git ignores do not constrain the runner or imports. Any real input outside
// the listed snapshot makes a receipt uncertain; nested dependencies do too.
async function validateInputs(repo, listed, observations) {
  const known = new Set(listed.map(file => path.resolve(repo, file)));
  const walk = async directory => {
    const before = await lstat(directory, { bigint: true });
    if (!before.isDirectory()) throw new Error("uncertain input directory");
    observe(directory, before, observations);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") throw new Error("nested installed dependencies");
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (!known.has(full)) throw new Error("unlisted executable input");
    }
    if (!stable(before, await lstat(directory, { bigint: true }))) throw new Error("changed input membership");
  };
  for (const name of ["tests", "packages", "bin", "scripts", "docs", "examples"]) {
    const directory = path.join(repo, name);
    const info = await lstat(directory).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
    if (info) await walk(directory);
  }
}

// The project has no external runtime dependencies. npm's ignored workspace
// links are safe only when every installed entry really resolves into packages.
async function workspaceLinks(repo, observations) {
  const modules = path.join(repo, "node_modules");
  const memberships = [];
  const members = async directory => {
    const before = await lstat(directory, { bigint: true });
    if (!before.isDirectory()) throw new Error("uncertain dependency directory");
    observe(directory, before, observations);
    memberships.push([directory, before]);
    return readdir(directory);
  };
  const entries = await members(modules).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
  if (entries === null) return "absent";
  const manifest = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8"));
  if (JSON.stringify(manifest.workspaces) !== JSON.stringify(["packages/*"])) throw new Error("unknown workspaces");
  const expected = new Map();
  for (const entry of await readdir(path.join(repo, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const location = path.join(repo, "packages", entry.name);
    const pkg = JSON.parse(await readFile(path.join(location, "package.json"), "utf8"));
    if (typeof pkg.name !== "string" || expected.has(pkg.name)) throw new Error("uncertain workspace");
    expected.set(pkg.name, await realpath(location));
  }
  const actual = [];
  for (const entry of entries.sort()) {
    if (entry === ".package-lock.json") {
      actual.push([entry, await fileIdentity(path.join(modules, entry), observations)]);
    } else if (entry.startsWith("@")) {
      for (const child of (await members(path.join(modules, entry))).sort()) actual.push([`${entry}/${child}`]);
    } else actual.push([entry]);
  }
  for (const item of actual) {
    const [name] = item;
    if (name === ".package-lock.json") continue;
    const link = path.join(modules, name);
    observe(link, await lstat(link, { bigint: true }), observations);
    if (!(await lstat(link)).isSymbolicLink() || await realpath(link) !== expected.get(name)) {
      throw new Error("unknown installed dependency");
    }
    item.push(await readlink(link), expected.get(name));
    expected.delete(name);
  }
  if (expected.size) throw new Error("missing workspace link");
  for (const [directory, before] of memberships) {
    if (!stable(before, await lstat(directory, { bigint: true }))) throw new Error("changed installed membership");
  }
  return actual;
}

export async function testFingerprint(repo, { env = process.env } = {}) {
  try {
    const root = await realpath(repo);
    if (inside(root, await realpath(tmpdir()))) return null;
    const gitEnv = { ...env };
    for (const name of excludedEnv) if (name.startsWith("GIT_")) delete gitEnv[name];
    const git = args => run("git", ["-C", root, ...args], { env: gitEnv, maxBuffer: 64 * 1024 * 1024 });
    const top = (await git(["rev-parse", "--show-toplevel"])).stdout.trim();
    if (await realpath(top) !== root) return null;
    const list = async () => [...new Set((await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]))
      .stdout.split("\0").filter(Boolean))].sort();
    const files = await list();
    if (!files.length || files.some(file => file.includes("\uFFFD"))) return null;
    // Git injects its default exec path into hooks. Query without that variable
    // so an explicitly configured custom path cannot masquerade as the default.
    const defaultEnv = { ...gitEnv };
    for (const name of Object.keys(defaultEnv)) if (envName(name) === "GIT_EXEC_PATH") delete defaultEnv[name];
    const defaultGitExecPath = (await run("git", ["--exec-path"], { env: defaultEnv })).stdout.trim();
    const observations = [];
    await validateInputs(root, files, observations);
    const directories = new Set([root]);
    for (const file of files) {
      let parent = path.dirname(path.join(root, file));
      while (parent !== root && inside(root, parent)) {
        directories.add(parent);
        parent = path.dirname(parent);
      }
    }
    for (const parent of [...directories].sort()) observe(parent, await lstat(parent, { bigint: true }), observations);
    const hash = createHash("sha256");
    hash.update(JSON.stringify([VERSION, root, await runtime(observations), await testEnvironment(env, defaultGitExecPath),
      await workspaceLinks(root, observations)]));
    for (const file of files) hash.update(JSON.stringify([file, await fileIdentity(path.join(root, file), observations)]));
    if (JSON.stringify(files) !== JSON.stringify(await list())) return null;
    return { key: hash.digest("hex"), stamp: digest(JSON.stringify(observations)) };
  } catch { return null; }
}

// Parse semantics depend on the running Node executable and its options, not
// just source bytes. Sharing its digest within this short checker avoids reading
// the executable once for each of hundreds of modules.
let syntaxRuntime;
export async function syntaxFingerprint(file) {
  try {
    if (inside(path.resolve(import.meta.dirname, ".."), await realpath(tmpdir()))) return null;
    syntaxRuntime ??= runtime();
    return { key: digest(JSON.stringify([VERSION, "syntax", await realpath(file), await fileIdentity(file),
      await syntaxRuntime, normalizedEnv({ NODE_OPTIONS: process.env.NODE_OPTIONS, NODE_PATH: process.env.NODE_PATH })])) };
  } catch { return null; }
}

function receiptFile(kind, snapshot) {
  if (!/^[a-z-]+$/.test(kind) || !/^[a-f0-9]{64}$/.test(snapshot?.key ?? "")) return null;
  return path.join(directory, `${kind}-${snapshot.key}.json`);
}

export async function hasPassed(kind, snapshot) {
  try {
    const file = receiptFile(kind, snapshot);
    if (!file) return false;
    const receipt = JSON.parse(await readFile(file, "utf8"));
    const age = Date.now() - receipt.passedAt;
    return receipt.version === VERSION && receipt.key === snapshot.key && receipt.kind === kind
      && Number.isFinite(receipt.passedAt) && Number.isFinite(age) && age >= 0 && age < MAX_AGE;
  } catch { return false; }
}

let cleaned = false;
export async function savePassed(kind, snapshot) {
  let temporary;
  try {
    const file = receiptFile(kind, snapshot);
    if (!file) return;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!cleaned) {
      cleaned = true;
      const now = Date.now();
      await Promise.all((await readdir(directory)).map(async name => {
        const candidate = path.join(directory, name);
        if (/^(?:test|tests|syntax)-[a-f0-9]{64}\.json$/.test(name)
          && now - (await lstat(candidate)).mtimeMs > MAX_AGE) await rm(candidate, { force: true });
      })).catch(() => {});
    }
    temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: VERSION, kind, key: snapshot.key, passedAt: Date.now() }),
      { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } catch { /* A failed cache write cannot change a successful gate result. */ }
  finally { if (temporary) await rm(temporary, { force: true }).catch(() => {}); }
}

export async function clearPassed(kind, snapshot) {
  const file = receiptFile(kind, snapshot);
  if (file) await rm(file, { force: true }).catch(() => {});
}
