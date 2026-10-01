import { fakeAgy } from "../../packages/adapter-antigravity/test/fake-agy.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { ALL_ADAPTERS, clientContext } from "@agents-can-communicate/cli";

import { modelShells, runInShell } from "../helpers/host-shells.mjs";

const run = promisify(execFile);
const windows = process.platform === "win32";
const repo = path.resolve(import.meta.dirname, "..", "..");
const acc = path.join(repo, "bin", "acc.mjs");

/**
 * The command the skill hands an agent has to be one that runs.
 *
 * It used to say `acc`, which works only where the package is installed
 * globally. Hooks never had this problem - their command is pinned at install
 * time, because a hook's environment carries neither PATH nor a shell profile -
 * but the skill did, and the skill is the half an agent reads.
 *
 * The failure was not a refusal. A real Claude Code session, told to take a task
 * and finding no `acc`, read the store's JSON, worked out the schema, and wrote
 * records and events by hand - inventing an event type, a harness name, and its
 * own generation tokens. It then reported the work as coordinated. None of it
 * had gone through a lock, a generation check, or the event log.
 */
async function installed(t, adapterId, relative) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-skill-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  // The adapter's own install, not `acc install`: that one first asks whether
  // the client is on this machine, and what is under test here is what gets
  // written, not which clients happen to be installed on the test runner.
  const adapter = ALL_ADAPTERS().find(item => item.id === adapterId);
  assert.notEqual(adapter, undefined, `no adapter named ${adapterId}`);
  // Antigravity installs its skill through `agy plugin install`; a stand-in
  // that does what 1.2.7 was captured doing keeps the real binary out of tests.
  await adapter.install({ ...clientContext(home), runAgy: fakeAgy().run });
  return { home, skill: path.join(home, relative) };
}

/**
 * The shim an installed skill names. Quoted on most clients; bare on Antigravity
 * CLI where the path is one shell word, because 1.2.12 matched no allow rule
 * against a command whose first word was quoted (issue #214). On Windows every
 * client gets `node "<shim with forward slashes>"`, which bash, PowerShell and
 * cmd all read; `command` is that whole text.
 */
const shimIn = text => {
  if (windows) {
    const match = /(node "([A-Za-z]:\/[^"]*acc-cli\.mjs)")/.exec(text);
    return match === null ? undefined : match[2];
  }
  const match = /"([^"]*acc-cli\.sh)"|(?<![\w"])(\/[^\s"`]+acc-cli\.sh)/.exec(text);
  return match === null ? undefined : match[1] ?? match[2];
};
const commandIn = text => /node "[A-Za-z]:\/[^"]*acc-cli\.mjs"/.exec(text)?.[0];

const ADAPTERS = [
  ["kimi", ".kimi-code/plugins/managed/agents-can-communicate/skills/acc/SKILL.md"],
  ["claude_code",
    ".claude/plugins/marketplaces/acc-local/agents-can-communicate/skills/acc/SKILL.md"],
  ["codex", ".agents/acc-local/plugins/agents-can-communicate/skills/acc/SKILL.md"],
  ["gemini_cli", ".gemini/extensions/agents-can-communicate/skills/acc/SKILL.md"],
  ["grok", ".grok/skills/acc/SKILL.md"],
  // Where `agy plugin install` puts ACC's plugin. Named `acc`, because the copy
  // of the Gemini extension this client imports by itself shadows any plugin
  // called agents-can-communicate.
  ["antigravity", ".gemini/config/plugins/acc/skills/acc/SKILL.md"],
];

for (const [adapter, relative] of ADAPTERS) {
  test(`${adapter}: the installed skill leaves no placeholder behind`, async t => {
    const { skill } = await installed(t, adapter, relative);
    const text = await readFile(skill, "utf8");

    assert.equal(text.includes("{{ACC}}"), false,
      "the skill still tells the agent to run a placeholder");
    // One absolute path per example instead of a data home, an interpreter and
    // a script: the shim holds the pinning, so nothing here is found on PATH.
    const shim = shimIn(text);
    assert.equal(typeof shim, "string", "the skill carries no path to the CLI at all");
    // Windows has no execute bit: the command there names node, which runs the
    // shim as a script.
    const info = await stat(shim);
    assert.equal(windows ? info.isFile() : (info.mode & 0o111) !== 0, true,
      "the skill names a command the agent cannot execute");
  });
}

// Kimi's quoted form, and Antigravity's bare one.
for (const [adapter, relative] of [ADAPTERS[0], ADAPTERS[5]]) {
  test(`${adapter}: the command baked into the skill actually runs`, async t => {
    const { home, skill } = await installed(t, adapter, relative);
    const text = await readFile(skill, "utf8");

    // Taken from the file rather than reconstructed, and run as written: the
    // point is that what an agent copies out of the skill is what works.
    const shim = shimIn(text);
    assert.equal(typeof shim, "string", `no runnable command in:\n${text.slice(0, 400)}`);

    const project = path.join(home, "project");
    await mkdir(project, { recursive: true });
    const env = { ...process.env, ACC_DATA_HOME: path.join(home, "data"),
      GIT_DIR: "", GIT_WORK_TREE: "" };
    if (!windows) {
      const { stdout } = await run(shim, ["status", "--cwd", project, "--json"], { env });
      assert.equal(JSON.parse(stdout).ok, true);
      return;
    }
    // Windows: the command as the skill writes it, in each shell a model's
    // shell tool runs there.
    for (const model of await modelShells()) {
      const { stdout } = await runInShell(model.shell, model.call([commandIn(text), "status",
        "--cwd", model.ref("TEST_PROJECT"), "--json"]), { env: { ...env, TEST_PROJECT: project } });
      assert.equal(JSON.parse(stdout).ok, true, `${model.shell} did not run ${commandIn(text)}`);
    }
  });
}

test("the skill tells the agent not to write to the store by hand", async t => {
  const { skill } = await installed(t, "kimi", ADAPTERS[0][1]);
  const text = await readFile(skill, "utf8");

  // Saying it is the weakest of the three layers and still worth saying: the
  // strong one is that the command works, so improvising has no motive.
  assert.match(text, /Do not write to ACC's files yourself/);
});

test("every shipped skill is templated, none forgotten", async () => {
  // One bundle per row above. A new one that forgets to bake would ship a
  // skill telling agents to run a placeholder, and a new one with no row would
  // never have its installed copy checked at all - so the count is the table's,
  // not a number that has to be remembered.
  const roots = [];
  for (const entry of await readdir(path.join(repo, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const bundle of ["plugin", "extension"]) {
      const file = path.join(repo, "packages", entry.name, bundle,
        "skills", "acc", "SKILL.md");
      const text = await readFile(file, "utf8").catch(() => null);
      if (text !== null) roots.push({ file, text });
    }
  }

  assert.equal(roots.length, ADAPTERS.length, roots.map(item => item.file).join("\n"));
  for (const { file, text } of roots) {
    assert.match(text, /\{\{ACC\}\}/, `${file} ships without the placeholder to replace`);
  }
});
