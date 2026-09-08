#!/usr/bin/env node
// The disposable daemon lifecycle, two
// actual npm installs, byte assertions, cleanup, and evidence report form one
// safety gate; splitting it would create an unverified alternate setup path.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile }
  from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { prepareOwnedTools, resolveExecutable } from "./codex-local-daemon-harness.mjs";

const execute = promisify(execFile);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const exists = file => stat(file).then(() => true, () => false);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run(executable, args, options = {}) {
  try {
    return (await execute(executable, args,
      { timeout: 120_000, maxBuffer: 4_000_000, ...options })).stdout;
  } catch (error) {
    throw new Error(`${path.basename(executable)} ${args[0] ?? ""} failed: ${error.message}`,
      { cause: error });
  }
}

async function until(label, read, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`deadline: ${label}`);
}

async function command(cli, args, env, cwd) {
  const envelope = JSON.parse(await run(process.execPath, [cli, ...args, "--json"], { env, cwd }));
  assert.equal(envelope.ok, true, `installed ${path.basename(cli)} command failed`);
  const result = envelope.data ?? envelope;
  assert.deepEqual(result.failed ?? [], [], "installed command reported adapter failures");
  return result;
}

const installedRoot = prefix => path.join(prefix, "node_modules", "agents-can-communicate");

async function installTarball(tarball, prefix, env) {
  await run("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", tarball], { env });
  const root = installedRoot(prefix);
  await stat(path.join(root, "bin", "acc.mjs"));
  return root;
}

async function daemonPid(socket) {
  const output = await run("lsof", ["-t", socket]).catch(() => "");
  return Number(output.trim().split("\n")[0]) || null;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const RC_USER = "# user shell bytes\nalias user-only='printf kept'\n";
const TOML_USER = "model = \"gpt-5.6-sol\"\nmodel_reasoning_effort = \"low\"\n";
const USER_PLUGIN = Object.freeze({ name: "user-plugin",
  source: { source: "local", path: "./plugins/user-plugin" },
  policy: { installation: "INSTALLED_BY_DEFAULT", authentication: "ON_USE" },
  category: "Coding" });

async function seedUserConfig(place, codex) {
  await mkdir(path.dirname(place.marketplace), { recursive: true });
  await mkdir(place.codexHome, { recursive: true });
  const standalone = path.join(place.codexHome, "packages", "standalone");
  await mkdir(standalone, { recursive: true });
  await symlink(path.dirname(path.dirname(codex)), path.join(standalone, "current"));
  await writeFile(place.rcFile, RC_USER);
  await writeFile(place.config, TOML_USER);
  await writeFile(place.marketplace, `${JSON.stringify({ name: "acc-local",
    interface: { displayName: "User marketplace" }, plugins: [USER_PLUGIN] }, null, 4)}\n`);
}

async function seedSharedShim(place, legacyRoot, codex) {
  const module = await import(pathToFileURL(path.join(legacyRoot, "node_modules",
    "@agents-can-communicate", "installer", "src", "native-activation.mjs")));
  const result = await module.applyNativeActivation({ adapter: { id: "claude_code" },
    dataHome: place.dataHome, node: process.execPath,
    bootstrap: path.join(legacyRoot, "bin", "acc-bootstrap.mjs"),
    activation: { livePolicy: "actionable", protocolContract: "fixture-shared-shim",
      shell: "zsh", rcFile: place.rcFile, shimDir: place.shimDir,
      mechanisms: [{ kind: "shell-bootstrap", command: "claude",
        realExecutable: codex, prefixArgs: [] }] } });
  assert.equal(result.appendedRcBlock, false,
    "shared shim must reuse the legacy PATH block");
  return readFile(path.join(place.shimDir, "claude"), "utf8");
}

async function ownership(place) {
  return JSON.parse(await readFile(path.join(place.dataHome, "acc", "installs.json"), "utf8"));
}

const codexRecord = record => record.installs.find(item => item.adapterId === "codex") ?? null;
const ownedWrapper = record => codexRecord(record)?.nativeActivation?.mechanisms
  .find(item => item.kind === "shell-bootstrap")?.ownedFiles?.[0] ?? null;

async function userConfigPreserved(place, stripBlock) {
  const config = await readFile(place.config, "utf8");
  const marketplace = JSON.parse(await readFile(place.marketplace, "utf8"));
  return stripBlock(config) === TOML_USER
    && JSON.stringify(marketplace.plugins.find(item => item.name === USER_PLUGIN.name))
      === JSON.stringify(USER_PLUGIN);
}

export function migrationEnvironments(baseEnv, place) {
  const clean = Object.fromEntries(Object.entries(baseEnv).filter(([key]) =>
    !key.startsWith("ACC_") && !key.startsWith("CODEX_")
      && !["NODE_OPTIONS", "NODE_PATH"].includes(key)));
  const daemonEnv = { ...clean, HOME: place.home, CODEX_HOME: place.codexHome,
    SHELL: "/bin/zsh" };
  return { daemonEnv, commandEnv: { ...daemonEnv, ACC_DATA_HOME: place.dataHome,
    ACC_UPDATE_CHECK: "0", ACC_NO_UPDATE_CHECK: "1", ACC_PROBE_TIMEOUT_MS: "30000" } };
}

async function runCase({ root, name, modify, legacyRoot, candidateRoot, codex, baseEnv }) {
  const caseRoot = path.join(root, name);
  const home = path.join(caseRoot, "home");
  const place = { home, codexHome: path.join(caseRoot, "codex"),
    dataHome: path.join(caseRoot, "data"), project: path.join(caseRoot, "project") };
  place.rcFile = path.join(home, ".zshrc");
  place.config = path.join(place.codexHome, "config.toml");
  place.marketplace = path.join(home, ".agents", "acc-local", ".agents", "plugins",
    "marketplace.json");
  place.shimDir = path.join(place.dataHome, "acc", "bin");
  const socket = path.join(place.codexHome, "app-server-control", "app-server-control.sock");
  const { daemonEnv, commandEnv } = migrationEnvironments(baseEnv, place);
  await mkdir(place.project, { recursive: true });
  await seedUserConfig(place, codex);
  let pid = null;
  let stopped = false;
  try {
    await run(codex, ["app-server", "daemon", "start"], { cwd: place.project, env: daemonEnv });
    await until("legacy daemon socket", () => stat(socket).then(s => s.isSocket(), () => false));
    pid = await until("legacy daemon pid", () => daemonPid(socket));
    const legacyCli = path.join(legacyRoot, "bin", "acc.mjs");
    const candidateCli = path.join(candidateRoot, "bin", "acc.mjs");
    await command(legacyCli, ["install", "--adapter", "codex", "--delivery", "actionable"],
      commandEnv, place.project);
    const wrapper = path.join(place.shimDir, "codex");
    const original = await readFile(wrapper, "utf8");
    assert.match(original, /--remote/);
    assert.match(original, /unix:\/\//);
    const legacyOwned = ownedWrapper(await ownership(place));
    assert.equal(sha256(original), legacyOwned?.sha256,
      "legacy wrapper bytes must come from the installed ownership record");
    const shared = await seedSharedShim(place, legacyRoot, codex);
    const rcBefore = await readFile(place.rcFile, "utf8");
    const expectedWrapper = modify ? `${original}# user-owned wrapper edit\n` : null;
    if (modify) await writeFile(wrapper, expectedWrapper);

    const first = await command(candidateCli,
      ["install", "--adapter", "codex", "--delivery", "actionable"], commandEnv, place.project);
    const afterFirst = { rc: await readFile(place.rcFile, "utf8"),
      shared: await readFile(path.join(place.shimDir, "claude"), "utf8"),
      wrapper: await readFile(wrapper, "utf8").catch(() => null), record: await ownership(place) };
    const second = await command(candidateCli,
      ["install", "--adapter", "codex", "--delivery", "actionable"], commandEnv, place.project);
    const afterSecond = { rc: await readFile(place.rcFile, "utf8"),
      shared: await readFile(path.join(place.shimDir, "claude"), "utf8"),
      wrapper: await readFile(wrapper, "utf8").catch(() => null), record: await ownership(place) };
    const repeatStable = JSON.stringify(afterFirst) === JSON.stringify(afterSecond);
    const reportsKept = [...(first.operations?.[0]?.diagnostics ?? []),
      ...(second.operations?.[0]?.diagnostics ?? [])].some(line => /kept shim/.test(line));
    await command(candidateCli, ["uninstall", "--adapter", "codex"], commandEnv, place.project);
    const finalRecord = await ownership(place);
    const currentModule = await import(pathToFileURL(path.join(candidateRoot, "node_modules",
      "@agents-can-communicate", "adapter-sdk", "src", "toml-block.mjs")));
    const sharedShimPreserved = await readFile(path.join(place.shimDir, "claude"), "utf8")
      .then(bytes => bytes === shared, () => false);
    const pathBlockPreserved = await readFile(place.rcFile, "utf8")
      .then(bytes => bytes === rcBefore, () => false);
    const daemonRetained = await daemonPid(socket) === pid
      && await run(codex, ["app-server", "daemon", "version"], { cwd: place.project, env: daemonEnv })
        .then(() => true, () => false);
    const common = { legacyWrapperCreated: true, sharedShimPreserved, pathBlockPreserved,
      userConfigPreserved: await userConfigPreserved(place, currentModule.stripBlock),
      daemonRetained, repeatStable };
    return modify ? { ...common,
      wrapperPreserved: await readFile(wrapper, "utf8").then(bytes => bytes === expectedWrapper,
        () => false),
      ownershipPreserved: ownedWrapper(finalRecord)?.sha256 === legacyOwned.sha256,
      preservationReported: reportsKept } : { ...common, wrapperRetired: afterFirst.wrapper === null && afterSecond.wrapper === null && !await exists(wrapper) };
  } finally {
    await run(codex, ["app-server", "daemon", "stop"], { cwd: place.project, env: daemonEnv }).catch(() => null);
    if (pid !== null) {
      stopped = await until("legacy daemon stop", () => !processAlive(pid))
        .then(() => true, () => false);
      assert.equal(stopped, true, "owned legacy migration daemon did not stop");
    }
  }
}

export function assertMigrationOutcome(value) {
  const checks = [
    [value.unmodified.legacyWrapperCreated, "legacy install did not create the Codex wrapper"],
    [value.unmodified.wrapperRetired, "unmodified legacy Codex wrapper was not retired"],
    [value.unmodified.sharedShimPreserved, "shared shim was removed"],
    [value.unmodified.pathBlockPreserved, "shared PATH block was removed"],
    [value.unmodified.userConfigPreserved, "unrelated user configuration changed"],
    [value.unmodified.daemonRetained, "pre-existing daemon was not retained"],
    [value.unmodified.repeatStable, "repeated unmodified migration changed bytes"],
    [value.modified.legacyWrapperCreated, "legacy install did not create the modified-case Codex wrapper"],
    [value.modified.wrapperPreserved, "modified legacy Codex wrapper was removed"],
    [value.modified.ownershipPreserved, "modified legacy Codex wrapper lost cleanup authority"],
    [value.modified.preservationReported, "modified legacy Codex wrapper was not reported as retained"],
    [value.modified.sharedShimPreserved, "modified-case shared shim was removed"],
    [value.modified.pathBlockPreserved, "modified-case PATH block was removed"],
    [value.modified.userConfigPreserved, "unrelated user configuration changed"],
    [value.modified.daemonRetained, "pre-existing daemon was not retained"],
    [value.modified.repeatStable, "repeated modified migration changed bytes"],
  ];
  for (const [observed, message] of checks) assert.equal(observed, true, message);
  return { ...value, assertionCount: checks.length };
}

function reportFor(result) {
  const row = (name, value) => `| ${name} | ${value ? "pass" : "fail"} |`;
  return `# Legacy Codex wrapper migration\n\n`
    + `Observed ${result.observedAt} with Codex ${result.clientVersion} on ${result.platform}. `
    + `Legacy package SHA-256: \`${result.legacyPackageSha256}\`; candidate: `
    + `\`${result.candidatePackageSha256}\`. Both CLIs and all inspected bytes came from npm prefixes.\n\n`
    + `| Assertion | Result |\n| --- | --- |\n`
    + `${row("unmodified wrapper retired", result.unmodified.wrapperRetired)}\n`
    + `${row("modified wrapper and cleanup authority preserved", result.modified.wrapperPreserved
      && result.modified.ownershipPreserved)}\n`
    + `${row("shared Claude shim and PATH block preserved", result.unmodified.sharedShimPreserved
      && result.unmodified.pathBlockPreserved && result.modified.sharedShimPreserved
      && result.modified.pathBlockPreserved)}\n`
    + `${row("unrelated TOML and marketplace configuration preserved",
      result.unmodified.userConfigPreserved && result.modified.userConfigPreserved)}\n`
    + `${row("pre-existing daemon retained through migration",
      result.unmodified.daemonRetained && result.modified.daemonRetained)}\n`
    + `${row("repeat install idempotent", result.unmodified.repeatStable
      && result.modified.repeatStable)}\n\n`
    + `Cleanup: ${result.cleanup.outcome}; ${result.assertionCount} behavioral assertions.\n`;
}

export async function runLegacyMigration({ legacyTarball, candidateTarball, codex, output }) {
  for (const [name, value] of Object.entries({ legacyTarball, candidateTarball, codex, output })) {
    assert.equal(path.isAbsolute(value), true, `${name} must be an absolute path`);
    if (name !== "output") await stat(value);
  }
  const temporaryBase = os.tmpdir().startsWith("/var/") ? "/tmp" : os.tmpdir();
  const root = await realpath(await mkdtemp(path.join(temporaryBase, "acc-legacy-migration-")));
  let removed = false;
  try {
    const inherited = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !key.startsWith("ACC_") && !key.startsWith("CODEX_")
        && !["NODE_OPTIONS", "NODE_PATH"].includes(key)));
    const npm = await resolveExecutable("npm");
    if (npm === null) throw new Error("prerequisite: npm unavailable");
    const toolDir = path.join(root, "owned-tools");
    await prepareOwnedTools({ toolDir, npm });
    const baseEnv = { ...inherited,
      PATH: `${path.dirname(codex)}:${toolDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      npm_config_cache: path.join(root, "npm-cache") };
    const [legacyRoot, candidateRoot] = await Promise.all([
      installTarball(legacyTarball, path.join(root, "legacy-prefix"), baseEnv),
      installTarball(candidateTarball, path.join(root, "candidate-prefix"), baseEnv),
    ]);
    const clientVersion = /^codex-cli (\d+\.\d+\.\d+)$/.exec(
      (await run(codex, ["--version"], { env: baseEnv })).trim())?.[1];
    assert.ok(clientVersion, "supplied Codex binary must report an exact stable version");
    const outcome = { unmodified: await runCase({ root, name: "unmodified", modify: false,
      legacyRoot, candidateRoot, codex, baseEnv }), modified: await runCase({ root,
      name: "modified", modify: true, legacyRoot, candidateRoot, codex, baseEnv }) };
    await rm(root, { recursive: true, force: true });
    removed = true;
    const checked = assertMigrationOutcome({ schemaVersion: 1,
      observedAt: new Date().toISOString(), clientVersion,
      platform: `${process.platform}-${process.arch}`,
      legacyPackageSha256: sha256(await readFile(legacyTarball)),
      candidatePackageSha256: sha256(await readFile(candidateTarball)),
      ...outcome, cleanup: { attempted: true, outcome: "passed",
        ownedProcesses: "stopped", temporaryState: "removed" } });
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, reportFor(checked));
    return checked;
  } finally {
    if (!removed) await rm(root, { recursive: true, force: true }).catch(() => null);
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: {
    "legacy-tarball": { type: "string" }, "candidate-tarball": { type: "string" },
    codex: { type: "string" }, output: { type: "string" },
  }, strict: true });
  const result = await runLegacyMigration({ legacyTarball: values["legacy-tarball"],
    candidateTarball: values["candidate-tarball"], codex: values.codex, output: values.output });
  console.log(JSON.stringify(result));
}
