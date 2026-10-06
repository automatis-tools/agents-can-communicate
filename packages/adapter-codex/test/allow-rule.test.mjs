import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCodexAdapter } from "../src/adapter.mjs";
import { PARTICIPANT_COMMANDS, allowRuleText, rulesPath, writeAllowRule } from "../src/allow-rule.mjs";
import { POSIX_FORM } from "../../../tests/helpers/platform-scope.mjs";

/**
 * The rule that lets ACC's coordination commands skip Codex's approval.
 *
 * A Codex session with `approvals_reviewer = "auto_review"` ran its ACC commands
 * with `require_escalated`, so each went to the reviewer, and the reviewer
 * refused a reply that named a branch, a commit and changed paths as disclosure
 * to "an external ACC peer" (Codex 0.160, 2026-10-05). From then on the session
 * told every peer it could not share project details. A command a prefix rule
 * allows needs no approval, so it reaches no reviewer.
 */

// A Windows host's temp paths hold backslashes, which a rule cannot take as
// they are, so a POSIX-form install there writes no rule - as a Windows install
// writes none at all (both tested below, on every host).
const POSIX_PATHS = process.platform === "win32"
  ? "this host's paths hold backslashes, and such a wrapper path gets no rule" : false;

async function fixture(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-codex-rule-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const codexHome = path.join(home, ".codex");
  const shim = path.join(home, ".agents", "acc-local", "plugins", "agents-can-communicate", "acc-cli.sh");
  return { context: { home, codexHome, hostPlatform: POSIX_FORM }, codexHome, shim };
}

test("install allows ACC's coordination commands through the wrapper, and nothing else", { skip: POSIX_PATHS }, async t => {
  const { context, codexHome, shim } = await fixture(t);

  const result = await createCodexAdapter().install(context);

  const text = await readFile(rulesPath(codexHome), "utf8");
  assert.ok(result.changes.includes(rulesPath(codexHome)));
  assert.match(text, /decision = "allow"/);
  assert.ok(text.includes(JSON.stringify(shim)), "the rule names the wrapper by its full path");
  for (const command of PARTICIPANT_COMMANDS) assert.ok(text.includes(`"${command}"`), command);
  for (const command of ["install", "uninstall", "update", "config", "prune"]) {
    assert.equal(text.includes(`"${command}"`), false, `${command} must stay behind approval`);
  }
});

test("install declares the rule file it writes, so uninstall takes it back", async t => {
  const { context, codexHome } = await fixture(t);

  const planned = createCodexAdapter().planInstall(context);

  assert.deepEqual(planned.filter(item => item.path === rulesPath(codexHome)),
    [{ path: rulesPath(codexHome), kind: "tree" }]);
});

test("a rules file of the same name that ACC did not write stays the operator's", { skip: POSIX_PATHS }, async t => {
  const { context, codexHome } = await fixture(t);
  await mkdir(path.dirname(rulesPath(codexHome)), { recursive: true });
  const theirs = 'prefix_rule(pattern=["git", "status"], decision="allow")\n';
  await writeFile(rulesPath(codexHome), theirs);

  const result = await createCodexAdapter().install(context);

  assert.equal(await readFile(rulesPath(codexHome), "utf8"), theirs);
  assert.equal(result.changes.includes(rulesPath(codexHome)), false);
  assert.ok(result.diagnostics.some(line => line.includes(rulesPath(codexHome))));
});

test("Windows gets no rule: how Codex matches a PowerShell command against one is unmeasured", async t => {
  const { context, codexHome } = await fixture(t);

  const result = await createCodexAdapter().install({ ...context, hostPlatform: "win32" });

  await assert.rejects(readFile(rulesPath(codexHome), "utf8"), { code: "ENOENT" });
  assert.equal(result.changes.includes(rulesPath(codexHome)), false);
  assert.deepEqual(createCodexAdapter().planInstall({ ...context, hostPlatform: "win32" })
    .filter(item => item.path === rulesPath(codexHome)), []);
});

test("doctor reports the rule, and asks for a reinstall when it is missing", { skip: POSIX_PATHS }, async t => {
  const { context, codexHome } = await fixture(t);
  const adapter = createCodexAdapter();
  await adapter.install(context);

  const present = await adapter.detect(context);
  assert.ok(present.diagnostics.some(line => line.includes("without an approval prompt")));

  await rm(rulesPath(codexHome));
  const missing = await adapter.detect(context);
  assert.ok(missing.needsAction.some(line => line.includes("acc install --adapter codex")));
});

test("uninstall takes ACC's rule back, and leaves one the operator edited", { skip: POSIX_PATHS }, async t => {
  const { context, codexHome } = await fixture(t);
  const adapter = createCodexAdapter();
  await adapter.install(context);

  await adapter.uninstall(context);
  await assert.rejects(readFile(rulesPath(codexHome), "utf8"), { code: "ENOENT" });

  await adapter.install(context);
  const edited = `${await readFile(rulesPath(codexHome), "utf8")}# mine\n`;
  await writeFile(rulesPath(codexHome), edited);
  await adapter.uninstall(context);
  assert.equal(await readFile(rulesPath(codexHome), "utf8"), edited);
});

// AI review of #261: a file that keeps ACC's header but drops `reply` is the
// operator narrowing what skips approval, and a reinstall restored `reply`.
test("a reinstall leaves an ACC rule the operator edited as it is", { skip: POSIX_PATHS }, async t => {
  const { context, codexHome } = await fixture(t);
  const adapter = createCodexAdapter();
  await adapter.install(context);
  const narrowed = (await readFile(rulesPath(codexHome), "utf8")).replace('"reply", ', "");
  await writeFile(rulesPath(codexHome), narrowed);

  const result = await adapter.install(context);

  assert.equal(await readFile(rulesPath(codexHome), "utf8"), narrowed);
  assert.ok(result.diagnostics.some(line => line.includes("edited")));
  const detected = await adapter.detect(context);
  assert.ok(detected.diagnostics.some(line => line.includes("edited")));
  assert.equal(detected.needsAction.some(line => line.includes(rulesPath(codexHome))), false);
});

test("an unchanged ACC rule for an older wrapper path is replaced", { skip: POSIX_PATHS }, async t => {
  const { context, codexHome } = await fixture(t);
  await mkdir(path.dirname(rulesPath(codexHome)), { recursive: true });
  await writeFile(rulesPath(codexHome), allowRuleText("/old/home/.agents/acc-local/plugins/agents-can-communicate/acc-cli.sh"));

  const result = await createCodexAdapter().install(context);

  assert.ok(result.changes.includes(rulesPath(codexHome)));
  assert.equal((await readFile(rulesPath(codexHome), "utf8")).includes("/old/home/"), false);
});

test("a wrapper path a rule cannot hold as it is gets no rule", async t => {
  const { codexHome } = await fixture(t);

  const result = await writeAllowRule({ codexHome, cliShim: "C:\\Users\\me\\acc-cli.sh",
    hostPlatform: POSIX_FORM });

  assert.equal(result.file, null);
  assert.ok(result.diagnostics.some(line => line.includes("cannot be written in a rule")));
  await assert.rejects(readFile(rulesPath(codexHome), "utf8"), { code: "ENOENT" });
});
