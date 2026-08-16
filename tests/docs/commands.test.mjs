import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");

/**
 * Documentation that is executed rather than proofread.
 *
 * A command in a README is a promise. Blocks marked `<!-- test:command -->` are
 * extracted and run against a throwaway home, so a flag that gets renamed breaks
 * the docs the same day it breaks the code.
 */
const MARKER = "<!-- test:command -->";

async function markedCommands(file) {
  const text = await readFile(file, "utf8");
  const blocks = [];
  const pattern = new RegExp(`${MARKER}\\s*\`\`\`bash\\n([\\s\\S]*?)\`\`\``, "g");
  for (const match of text.matchAll(pattern)) {
    for (const line of match[1].split("\n")) {
      const command = line.trim();
      if (command !== "" && !command.startsWith("#")) blocks.push(command);
    }
  }
  return blocks;
}

const docs = async () => {
  const roots = [repo, path.join(repo, "docs"), path.join(repo, "examples")];
  const files = [];
  for (const root of roots) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) files.push(path.join(root, entry.name));
    }
  }
  return files;
};

async function sandbox(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-docs-home-")));
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "acc-docs-cwd-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-docs-data-")));
  t.after(() => Promise.all([home, cwd, dataHome]
    .map(dir => rm(dir, { recursive: true, force: true }))));
  return { home, cwd, dataHome };
}

test("every documented command is one the CLI still accepts", async t => {
  const place = await sandbox(t);
  const files = await docs();
  const commands = (await Promise.all(files.map(markedCommands))).flat();

  assert.equal(commands.length > 0, true, "no documented commands are marked for testing");

  for (const command of commands) {
    // Run through the repository's own binary rather than a published one, and
    // in a throwaway home so nothing on the machine is touched.
    const argv = command.replace(/^acc\s+/, "").split(/\s+/);
    const { stdout } = await run(process.execPath,
      [path.join(repo, "bin", "acc.mjs"), ...argv, "--cwd", place.cwd, "--json"],
      { env: { ...process.env, HOME: place.home, ACC_DATA_HOME: place.dataHome,
        GIT_DIR: "", GIT_WORK_TREE: "" } })
      .catch(error => { throw new Error(`${command}\n${error.stdout || error.message}`); });
    assert.equal(JSON.parse(stdout).ok, true, command);
  }
});

test("the getting-started guide covers the flow it promises", async () => {
  const guide = await readFile(path.join(repo, "docs", "GETTING_STARTED.md"), "utf8");

  // Named because they are the arc a first-time reader needs: install, a normal
  // session attaching by itself, seeing peers, a conflict, a message, removal.
  for (const step of ["acc install", "acc status", "acc claim", "acc message",
    "acc uninstall"]) {
    assert.match(guide, new RegExp(step.replace(/\s+/g, "\\s+")), `missing: ${step}`);
  }
  // The distinction that decides what a reader should expect.
  assert.match(guide, /MCP/);
});

test("every command the CLI accepts appears in the CLI reference", async () => {
  const { COMMANDS } = await import("@agents-can-communicate/cli");
  const reference = await readFile(path.join(repo, "docs", "CLI.md"), "utf8");

  for (const command of Object.keys(COMMANDS)) {
    assert.match(reference, new RegExp(`\\bacc ${command}\\b`),
      `acc ${command} is not documented`);
  }
});

test("the adapter guide describes the contract an author must satisfy", async () => {
  const guide = await readFile(path.join(repo, "docs", "ADAPTER_AUTHORING.md"), "utf8");

  for (const required of ["normalizeHook", "planInstall", "denyOutcome", "capabilities",
    "defineAdapter"]) {
    assert.match(guide, new RegExp(required), `missing: ${required}`);
  }
});
