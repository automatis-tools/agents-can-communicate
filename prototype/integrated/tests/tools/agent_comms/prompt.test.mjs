import assert from "node:assert/strict";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { renderPrompt } from "../../../tools/agents/lib/prompt.mjs";
import { createGitWorktreeFixture, runCli } from "./helpers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const templatePath = path.join(root, "docs/AGENT_COMMS_PROMPT.md");

test("rendered prompt is the committed template with literal substitutions", async () => {
  const template = await readFile(templatePath, "utf8");
  const rendered = await renderPrompt({
    templatePath,
    agentId: "visual-m2-7",
    role: "visual",
    task: "M2.7",
    ownership: "game/presentation",
  });
  const expected = template
    .replaceAll("<AGENT_ID_SHELL>", "'visual-m2-7'")
    .replaceAll("<ROLE_SHELL>", "'visual'")
    .replaceAll("<TASK_SHELL>", "'M2.7'")
    .replaceAll("<OWNERSHIP_SHELL>", "'game/presentation'")
    .replaceAll("<AGENT_ID>", "visual-m2-7")
    .replaceAll("<ROLE>", "visual")
    .replaceAll("<TASK>", "M2.7")
    .replaceAll("<OWNERSHIP>", "game/presentation");

  assert.equal(rendered, expected);
  assert.deepEqual(
    [...new Set(template.match(/<[A-Z_]+>/gu) ?? [])].sort(),
    ["<AGENT_ID>", "<AGENT_ID_SHELL>", "<OWNERSHIP>", "<OWNERSHIP_SHELL>",
      "<ROLE>", "<ROLE_SHELL>", "<TASK>", "<TASK_SHELL>"],
  );
});

test("canonical prompt requires the complete safe coordination lifecycle", async () => {
  const rendered = await renderPrompt({
    templatePath,
    agentId: "visual-m2-7",
    role: "visual",
    task: "M2.7",
    ownership: "game/presentation",
  });

  for (const checkpoint of [
    "одразу після `register`",
    "перед першою зміною файлів",
    "після кожної довгої команди або повернення до задачі",
    "перед зміною shared contract",
    "перед commit",
    "перед push/PR",
    "перед переходом до нового етапу",
    "через `wait`, коли агент не має іншої роботи",
  ]) assert.match(rendered, new RegExp(checkpoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(rendered, /Відмова `register` або неможливість запустити watcher —\s*блокер/u);
  assert.match(rendered, /explicit peer\s+підтвердження.*before changing the shared contract/u);
  assert.match(rendered, /`reply`[\s\S]*`ack`/u);
  assert.match(rendered, /`action` or `blocker`[\s\S]*`reply`[\s\S]*`ack`/u);
  assert.match(rendered, /evidence-bearing handoff even when blocked[\s\S]*`close/u);
  assert.match(rendered, /may not interrupt an active reasoning-turn/u);
  assert.match(rendered, /read `AGENTS\.md` and `docs\/AGENT_COMMS\.md` completely before/u);
  assert.match(rendered, /report your id, task, and\s+ownership scopes to the orchestrator/u);
});

test("rendered bootstrap shell-quotes every substituted command value", async () => {
  const rendered = await renderPrompt({
    templatePath,
    agentId: "visual",
    role: "visual lead",
    task: "actor's polish",
    ownership: "game/presentation --ownership contract:camera rig-v1",
  });

  assert.match(rendered, /--id 'visual' --role 'visual lead' --task 'actor'"'"'s polish'/u);
  assert.match(rendered,
    /--ownership 'game\/presentation' --ownership 'contract:camera rig-v1'/u);
});

test("renderer rejects unsafe agent identifiers and NUL-bearing values", async () => {
  await assert.rejects(
    renderPrompt({ templatePath, agentId: "INVALID", role: "visual", task: "M2.7", ownership: "game/presentation" }),
    /invalid agent id/u,
  );
  await assert.rejects(
    renderPrompt({ templatePath, agentId: "visual-m2-7", role: "visual\0", task: "M2.7", ownership: "game/presentation" }),
    /NUL/u,
  );
});

test("prompt command writes the renderer output without stderr", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  const fixtureTemplate = path.join(fixture.worktree, "docs/AGENT_COMMS_PROMPT.md");
  await mkdir(path.dirname(fixtureTemplate), { recursive: true });
  await copyFile(templatePath, fixtureTemplate);
  const expected = await renderPrompt({
    templatePath: fixtureTemplate,
    agentId: "visual",
    role: "visual",
    task: "M2.7",
    ownership: "game/presentation",
  });
  const result = await runCli(fixture, ["prompt", "--id", "visual", "--role", "visual", "--task",
    "M2.7", "--ownership", "game/presentation"]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, expected);
  assert.equal(result.stderr, "");
});

test("prompt command rejects missing ownership before rendering", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  const result = await runCli(fixture, ["prompt", "--id", "visual", "--role", "visual", "--task", "M2.7"]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /prompt requires every --ownership/u);
  assert.equal(result.stdout, "");
});

test("prompt command rejects a blank ownership among repeated scopes", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  const result = await runCli(fixture, ["prompt", "--id", "visual", "--role", "visual", "--task",
    "M2.7", "--ownership", "", "--ownership", "game/presentation"]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /prompt requires every --ownership/u);
  assert.equal(result.stdout, "");
});
