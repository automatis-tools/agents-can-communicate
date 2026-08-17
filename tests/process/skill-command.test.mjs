import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { ALL_ADAPTERS, clientContext } from "@agents-can-communicate/cli";

const run = promisify(execFile);
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
  await adapter.install(clientContext(home));
  return { home, skill: path.join(home, relative) };
}

const ADAPTERS = [
  ["kimi", ".kimi-code/plugins/managed/agents-can-communicate/skills/acc/SKILL.md"],
  ["claude_code",
    ".claude/plugins/marketplaces/acc-local/agents-can-communicate/skills/acc/SKILL.md"],
  ["codex", ".agents/plugins/plugins/agents-can-communicate/skills/acc/SKILL.md"],
  ["gemini_cli", ".gemini/extensions/agents-can-communicate/skills/acc/SKILL.md"],
];

for (const [adapter, relative] of ADAPTERS) {
  test(`${adapter}: the installed skill leaves no placeholder behind`, async t => {
    const { skill } = await installed(t, adapter, relative);
    const text = await readFile(skill, "utf8");

    assert.equal(text.includes("{{ACC}}"), false,
      "the skill still tells the agent to run a placeholder");
    assert.match(text, /acc\.mjs/, "the skill carries no path to the CLI at all");
  });
}

test("the command baked into the skill actually runs", async t => {
  const { home, skill } = await installed(t, "kimi", ADAPTERS[0][1]);
  const text = await readFile(skill, "utf8");

  // Taken from the file rather than reconstructed: the point is that what an
  // agent copies out of the skill is what works.
  const [, node, cli] = /"([^"]*node[^"]*)" "([^"]*acc\.mjs)"/.exec(text) ?? [];
  assert.equal(typeof node, "string", `no runnable command in:\n${text.slice(0, 400)}`);

  const project = path.join(home, "project");
  await mkdir(project, { recursive: true });
  const { stdout } = await run(node, [cli, "status", "--cwd", project, "--json"],
    { env: { ...process.env, ACC_DATA_HOME: path.join(home, "data"),
      GIT_DIR: "", GIT_WORK_TREE: "" } });

  assert.equal(JSON.parse(stdout).ok, true);
});

test("the skill tells the agent not to write to the store by hand", async t => {
  const { skill } = await installed(t, "kimi", ADAPTERS[0][1]);
  const text = await readFile(skill, "utf8");

  // Saying it is the weakest of the three layers and still worth saying: the
  // strong one is that the command works, so improvising has no motive.
  assert.match(text, /Do not write to ACC's files yourself/);
});

test("every shipped skill is templated, none forgotten", async () => {
  // Four adapters, four bundles. A new one that forgets to bake would ship a
  // skill telling agents to run a placeholder.
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

  assert.equal(roots.length, 4, roots.map(item => item.file).join("\n"));
  for (const { file, text } of roots) {
    assert.match(text, /\{\{ACC\}\}/, `${file} ships without the placeholder to replace`);
  }
});
