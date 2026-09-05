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

async function shippedMarkdown() {
  const manifest = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8"));
  const markdown = manifest.files.filter(entry => entry.endsWith(".md"));
  for (const required of ["README.md", "SECURITY.md"]) {
    assert.equal(markdown.includes(required), true, `${required} is no longer declared public`);
  }
  return markdown;
}

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

test("public docs describe the communication product that actually ships", async () => {
  const entries = await Promise.all((await shippedMarkdown()).map(async file => ({ file,
    source: await readFile(path.join(repo, file), "utf8") })));

  for (const { file, source } of entries) {
    assert.doesNotMatch(source, /\bacc (?:task|workstream|decide)\b/,
      `${file} teaches a removed orchestration command`);
    for (const line of source.split("\n")) {
      const staleReceipt = /(?:\b(?:receipt|delivery)\b.*\b(?:injected|seen)\b|\b(?:injected|seen)\b.*\b(?:receipt|delivery)\b|->.*\b(?:injected|seen)\b)/i;
      const clearlyNegative = /\b(?:no|not|never|without|cannot|removed|rejected)\b/i;
      if (staleReceipt.test(line) && !clearlyNegative.test(line)) {
        assert.fail(`${file} teaches stale receipt vocabulary: ${line.trim()}`);
      }
    }
  }

  const readme = entries.find(entry => entry.file === "README.md").source;
  const prompts = [...readme.matchAll(/^\| (?:Codex|Claude Code) \| ([^|]+) \|$/gm)]
    .map(match => match[1].trim());
  assert.equal(prompts.length >= 2, true, "README no longer gives two ordinary task prompts");
  for (const prompt of prompts) {
    assert.doesNotMatch(prompt, /\b(?:ACC|inbox|peer|session|coordinate)\b/i,
      `README turns an ordinary task prompt into coordination setup: ${prompt}`);
  }
  for (const target of ["docs/GETTING_STARTED.md", "docs/CAPABILITIES.md",
    "docs/TROUBLESHOOTING.md"]) {
    assert.equal(readme.includes(`](${target})`), true,
      `README does not route the reader to ${target}`);
  }

  const protocol = entries.find(entry => entry.file === "docs/PROTOCOL.md").source;
  assert.match(protocol, /queued\s*->\s*offered\s*->\s*retrieved\s*->\s*acknowledged/,
    "protocol lost the truthful receipt lifecycle");
  for (const distinction of [/offered[^\n]*not[^\n]*read/i,
    /retrieved[^\n]*not[^\n]*model attention/i,
    /reply[^\n]*not[^\n]*task completion/i]) {
    assert.match(protocol, distinction, `protocol lost distinction ${distinction}`);
  }

  const decisions = entries.find(entry => entry.file === "docs/DESIGN_DECISIONS.md").source;
  assert.match(decisions, /no coordinator, workstream, or task subsystem/i,
    "design decisions still describe the removed orchestration hierarchy");
  assert.match(decisions, /explicit peer conversations?[^\n]*(?:product|first-class)/i,
    "design decisions do not name peer conversations as product data");
  assert.match(decisions, /raw transcripts?[^\n]*(?:never|not)[^\n]*(?:collect|share)/i,
    "design decisions do not exclude raw transcript collection");

  const capabilities = entries.find(entry => entry.file === "docs/CAPABILITIES.md").source;
  for (const dimension of ["Certified support", "Current reachability", "Recipient policy",
    "Fallback"]) {
    assert.match(capabilities, new RegExp(`^## ${dimension}$`, "m"),
      `capabilities do not separate ${dimension.toLowerCase()}`);
  }
});

test("the release check uses the same isolated npm cache as pack and tests", async () => {
  const releasing = await readFile(path.join(repo, "docs", "RELEASING.md"), "utf8");
  assert.match(releasing,
    /env npm_config_cache=\/private\/tmp\/acc-npm-cache-v02 node scripts\/verify-package\.mjs/,
  "verify-package can fall back to the machine's root-owned npm cache");
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
