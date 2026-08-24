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

// Never published: the test suite, local configuration, capture material
// carrying paths from the machine that made it, and anything that looks like a
// live session.
const FORBIDDEN = [
  { pattern: /^tests\//, why: "test suite" },
  { pattern: /^\.github\//, why: "CI configuration" },
  { pattern: /^\.githooks\//, why: "local git hooks" },
  { pattern: /^\.agents\//, why: "local agent state" },
  { pattern: /(^|\/)fixtures\//, why: "capture material from a real machine" },
  { pattern: /(^|\/)test\//, why: "test suite" },
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
    ok(`${listed.length} entries, none forbidden`);

    // The workspaces have to travel inside the tarball, or every internal
    // import fails on install. This is the whole reason the package bundles.
    if (!listed.some(entry => entry.startsWith("node_modules/@agents-can-communicate/"))) {
      fail("the workspaces are not bundled; internal imports would fail on install");
    }
    ok("workspaces bundled");

    step("install into a clean directory");
    await writeFile(path.join(consumer, "package.json"),
      '{"name":"acc-verify","version":"1.0.0","private":true}\n');
    await runNpm(["install", "--silent", tarball], { cwd: consumer });
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
    await writeFile(path.join(clientHome, "config.toml"), 'default_model = "k3"\n');
    const before = await readFile(path.join(clientHome, "config.toml"), "utf8");
    // `acc install` fails the command when an adapter fails, so its output is
    // the diagnosis rather than something to discard.
    const installed = await acc("install", "--home", clientHome)
      .catch(error => { fail("install failed", error.stdout || error.message); });
    const removed = await acc("uninstall", "--home", clientHome)
      .catch(error => { fail("uninstall failed", error.stdout || error.message); });
    void installed; void removed;
    const after = await readFile(path.join(clientHome, "config.toml"), "utf8");
    if (after !== before) fail("uninstall did not restore the client config");
    ok("client config restored byte for byte");

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
