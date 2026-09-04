#!/usr/bin/env node
// Verify a built tarball the way a user receives it.
//
// Installs into a clean directory with no workspace anywhere, then exercises the
// product: doctor, a non-Git workspace, an install, and its removal. Development
// hides the failure this catches - workspace symlinks are always present there,
// so an unbundled package imports fine right up until someone else installs it.
//
// Usage: node scripts/verify-package.mjs [tarball]
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile }
  from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { gitProvenance } from "./git-provenance.mjs";
import { verifyCertificationFixtureAllowlist } from "./package-certification.mjs";
import { treeSnapshot } from "./tree-snapshot.mjs";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..");

// Node 20.12 and later refuse to spawn a .cmd or .bat without a shell (the
// CVE-2024-27980 fix), and npm on Windows is exactly that - a .cmd shim. So npm
// runs through a shell there, with arguments quoted because a temp path can
// contain spaces.
const isWindows = process.platform === "win32";
const runNpm = (args, options = {}) => (isWindows
  ? run("npm.cmd", args.map(argument => `"${argument}"`), { ...options, shell: true })
  : run("npm", args, options));

// Never published: the test suite, local configuration, and anything that
// looks like a live session. Redacted adapter certification captures are the
// one fixture exception: effective capability claims must remain inspectable.
const FORBIDDEN = [
  { pattern: /^tests\//, why: "test suite" },
  { pattern: /^\.github\//, why: "CI configuration" },
  { pattern: /^\.githooks\//, why: "local git hooks" },
  { pattern: /^\.agents\//, why: "local agent state" },
  { pattern: /(^|\/)test\//, why: "test suite" },
  { pattern: /(^|\/)scripts\/spikes\//, why: "native feasibility spike" },
  { pattern: /(^|\/)(?:runtime|transcript|secret)s?\//, why: "runtime or private state" },
  { pattern: /\.sock$/, why: "local socket" },
  { pattern: /\.jsonl$/, why: "looks like a transcript" },
];

const step = message => console.log(`\n== ${message}`);
const ok = message => console.log(`   ok  ${message}`);

function fail(message, detail = "") {
  console.error(`   FAIL ${message}${detail ? `\n${detail}` : ""}`);
  process.exitCode = 1;
  throw new Error(message);
}

async function packTarball(into) {
  const { stdout } = await runNpm(["pack", "--pack-destination", into], { cwd: repo });
  return path.join(into, stdout.trim().split("\n").at(-1));
}

async function entries(tarball) {
  const { stdout } = await run("tar", ["-tzf", tarball]);
  return stdout.split("\n").filter(Boolean).map(entry => entry.replace(/^package\//, ""));
}

async function readTarJson(tarball, entry) {
  const { stdout } = await run("tar", ["-xzOf", tarball, `package/${entry}`]);
  return JSON.parse(stdout);
}

async function readTarText(tarball, entry) {
  return (await run("tar", ["-xzOf", tarball, `package/${entry}`])).stdout;
}

function localMarkdownTargets(markdown, from) {
  const targets = [];
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const raw = match[1].replace(/^<|>$/g, "");
    if (/^(?:[a-z]+:|#)/i.test(raw)) continue;
    const local = decodeURIComponent(raw.split("#", 1)[0].split("?", 1)[0]);
    targets.push(path.posix.normalize(path.posix.join(path.posix.dirname(from), local)));
  }
  return targets;
}

async function main() {
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), "acc-verify-")));
  const consumer = path.join(workspace, "consumer");
  const project = path.join(workspace, "project");
  const dataHome = path.join(workspace, "data");
  const clientHome = path.join(workspace, "home");
  // Node's own mkdir rather than the shell's. `mkdir -p` is a cmd builtin on
  // Windows, not an executable execFile can find, so spawning it fails there -
  // and CI runs this matrix on windows-latest.
  for (const dir of [consumer, project, dataHome, clientHome]) {
    await mkdir(dir, { recursive: true });
  }

  try {
    step("pack");
    // Resolved before use: the install runs from a temporary directory, and a
    // path relative to the caller's shell would not exist there.
    const packed = process.argv[2] === undefined;
    const tarball = packed
      ? await packTarball(workspace)
      : path.resolve(process.argv[2]);
    const bytes = await readFile(tarball);
    const digest = createHash("sha256").update(bytes).digest("hex");
    ok(`${path.basename(tarball)}  ${(bytes.length / 1024).toFixed(0)} KB`);
    ok(`sha256 ${digest}`);

    const { commit, dirty, why } = packed
      ? await gitProvenance(repo)
      : { commit: null, dirty: false, why: "a tarball was supplied; HEAD is unrelated to it" };
    if (commit === null) {
      console.log(`   --  revision unknown: ${why}`);
    } else {
      ok(`built from ${commit}${dirty
        ? "  WITH UNCOMMITTED CHANGES - this tarball cannot be rebuilt"
        : ""}`);
    }

    step("tarball contents");
    const listed = await entries(tarball);
    for (const { pattern, why } of FORBIDDEN) {
      const hits = listed.filter(entry => pattern.test(entry));
      if (hits.length > 0) fail(`${why} is published`, hits.slice(0, 5).join("\n"));
    }
    const fixtureEntries = listed.filter(entry => entry.includes("/fixtures/"));
    const invalidFixtures = fixtureEntries.filter(entry =>
      !/^node_modules\/@agents-can-communicate\/adapter-[^/]+\/fixtures\//.test(entry));
    if (invalidFixtures.length > 0) {
      fail("non-certification fixture material is published", invalidFixtures.slice(0, 5).join("\n"));
    }
    const certifications = listed.filter(entry =>
      /^node_modules\/@agents-can-communicate\/adapter-[^/]+\/certification\.json$/.test(entry));
    if (certifications.length !== 5) {
      fail("every shipped adapter must carry certification.json", certifications.join("\n"));
    }
    await verifyCertificationFixtureAllowlist(listed,
      certification => readTarJson(tarball, certification))
      .catch(error => fail(error.message));
    ok(`${listed.length} entries, none forbidden`);
    ok(`${certifications.length} certification manifest(s), exact evidence allowlist shipped`);

    const packedEntries = new Set(listed);
    const missingLinks = [];
    for (const markdown of listed.filter(entry => entry.endsWith(".md"))) {
      for (const target of localMarkdownTargets(await readTarText(tarball, markdown), markdown)) {
        if (!packedEntries.has(target)) missingLinks.push(`${markdown} -> ${target}`);
      }
    }
    if (missingLinks.length > 0) {
      fail("packed documentation has missing local links", missingLinks.join("\n"));
    }
    ok("every packed Markdown link resolves inside the tarball");

    // The workspaces have to travel inside the tarball, or every internal
    // import fails on install. This is the whole reason the package bundles.
    if (!listed.some(entry => entry.startsWith("node_modules/@agents-can-communicate/"))) {
      fail("the workspaces are not bundled; internal imports would fail on install");
    }
    ok("workspaces bundled");
    const manifest = await readTarJson(tarball, "package.json");
    if (manifest.version !== "0.3.0") fail(`root version is ${manifest.version}, not 0.3.0`);
    if (!manifest.bundleDependencies?.includes("@agents-can-communicate/delivery-router")) {
      fail("delivery-router is not bundled; installed message commands cannot start");
    }
    for (const dependency of manifest.bundleDependencies) {
      const workspaceManifest = await readTarJson(tarball,
        `node_modules/${dependency}/package.json`);
      if (workspaceManifest.version !== "0.3.0") {
        fail(`${dependency} is ${workspaceManifest.version}, not 0.3.0`);
      }
    }
    const geminiManifest = await readTarJson(tarball,
      "node_modules/@agents-can-communicate/adapter-gemini-cli/"
      + "extension/gemini-extension.json");
    if (geminiManifest.version !== "0.3.0") {
      fail(`embedded Gemini extension is ${geminiManifest.version}, not 0.3.0`);
    }
    const codexPlugin = await readTarJson(tarball,
      "node_modules/@agents-can-communicate/adapter-codex/"
      + "plugin/.codex-plugin/plugin.json");
    if (codexPlugin.license !== "MIT") fail("shipped Codex plugin license is not MIT");
    ok(`root and ${manifest.bundleDependencies.length} bundled workspaces are 0.3.0`);

    step("install into a clean directory");
    await writeFile(path.join(consumer, "package.json"),
      '{"name":"acc-verify","version":"1.0.0","private":true}\n');
    await runNpm(["install", "--offline", "--silent", tarball], { cwd: consumer });
    const bin = path.join(consumer, "node_modules", ".bin");
    ok((await readdir(bin)).join(", "));

    const env = { ...process.env, ACC_DATA_HOME: dataHome, HOME: clientHome,
      GIT_DIR: "", GIT_WORK_TREE: "" };
    const acc = (...argv) => run(path.join(bin, "acc"), [...argv, "--json"], { env });

    step("doctor");
    const doctor = JSON.parse((await acc("doctor", "--cwd", project,
      "--home", clientHome)).stdout);
    if (doctor.ok !== true) fail("doctor reported a problem", JSON.stringify(doctor.error));
    ok(`${doctor.data.adapters.length} adapter(s) reported`);

    step("a workspace with no Git");
    const attached = JSON.parse((await acc("attach", "--participant", "verify",
      "--harness", "cli", "--cwd", project)).stdout).data;
    await acc("claim", "--session", attached.sessionId, "--generation",
      attached.generation, "--resource", "file:notes.txt", "--reason", "verifying",
      "--cwd", project);
    const status = JSON.parse((await acc("status", "--cwd", project)).stdout).data;
    if (status.claims.length !== 1) fail("the claim did not land");
    ok(`${status.participants.length} participant(s), ${status.claims.length} claim(s)`);

    // Coordination state belongs to the machine. A workspace with no repository
    // is exactly where a tool is tempted to drop a dotfile instead.
    const leftBehind = await readdir(project);
    if (leftBehind.length > 0) fail("state was written into the project", leftBehind.join(", "));
    ok("nothing written into the project");

    step("install and uninstall");
    const kimiHome = path.join(clientHome, ".kimi-code");
    await mkdir(kimiHome, { recursive: true });
    await writeFile(path.join(kimiHome, "config.toml"), 'default_model = "k3"\n');
    const before = await treeSnapshot(clientHome);
    // `acc install` fails the command when an adapter fails, so its output is
    // the diagnosis rather than something to discard.
    const installed = JSON.parse((await acc("install", "--adapter", "kimi",
      "--home", clientHome)
      .catch(error => fail("install failed", error.stdout || error.message))).stdout).data;
    if (installed.failed.length > 0 || installed.operations.length !== 1
      || installed.operations[0].adapterId !== "kimi"
      || installed.operations[0].applied !== true) {
      fail("install result did not apply the requested Kimi adapter", JSON.stringify(installed));
    }
    if (JSON.stringify(await treeSnapshot(clientHome)) === JSON.stringify(before)) {
      fail("install did not change the client-home topology");
    }
    const installedKimi = JSON.parse(await readFile(path.join(kimiHome, "plugins", "managed",
      "agents-can-communicate", ".kimi-plugin", "plugin.json"), "utf8"));
    if (installedKimi.version !== "0.3.0") fail("installed Kimi manifest is not 0.3.0");

    const removed = JSON.parse((await acc("uninstall", "--adapter", "kimi",
      "--home", clientHome)
      .catch(error => fail("uninstall failed", error.stdout || error.message))).stdout).data;
    if (removed.failed.length > 0 || removed.operations.length !== 1
      || removed.operations[0].applied !== true
      || (removed.operations[0].removed.length + removed.operations[0].changes.length) === 0) {
      fail("first uninstall did not report its removals", JSON.stringify(removed));
    }
    if (JSON.stringify(await treeSnapshot(clientHome)) !== JSON.stringify(before)) {
      fail("uninstall did not restore client-home topology and bytes");
    }

    const repeated = JSON.parse((await acc("uninstall", "--adapter", "kimi",
      "--home", clientHome)).stdout).data;
    const repeatedOperation = repeated.operations[0];
    if (repeated.failed.length > 0 || repeatedOperation?.applied !== true
      || (repeatedOperation.removed?.length ?? 0) > 0
      || (repeatedOperation.removedDirectories?.length ?? 0) > 0
      || (repeatedOperation.changes?.length ?? 0) > 0) {
      fail("second uninstall was not an idempotent no-op", JSON.stringify(repeated));
    }
    if (JSON.stringify(await treeSnapshot(clientHome)) !== JSON.stringify(before)) {
      fail("second uninstall changed client-home topology or bytes");
    }
    ok("client-home topology, modes, links, and bytes restored; repeated uninstall was a no-op");

    // One line to copy into the changelog, complete enough to be checkable
    // later: which file, which bytes, and which revision produced them.
    console.log(`\nPASS  ${path.basename(tarball)}  sha256 ${digest}`
      + `${commit === null ? "" : `  built from ${commit}${dirty ? " (dirty)" : ""}`}`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

// The message matters more than the stack: this runs in CI and in a release
// checklist, where the reader wants to know which gate refused and why.
await main().catch(error => {
  console.error(`\nFAIL  ${error.message}`);
  process.exitCode = 1;
});
