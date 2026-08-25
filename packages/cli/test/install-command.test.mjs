import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { recordInstall } from "@agents-can-communicate/installer";

import { runInstallCommand } from "../src/install-command.mjs";

/**
 * The command's own wiring.
 *
 * The plan knows how to remove an install whose client has left the machine -
 * but only when it is handed the record. Nothing else would notice that argument
 * being dropped: the tests that cover the rule pass the record in themselves,
 * and this is the only place that reads it off the disk.
 */
test("uninstall is planned from the record, not only from the machine", async t => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-cmd-home-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-cmd-data-")));
  t.after(() => Promise.all([home, dataHome]
    .map(dir => rm(dir, { recursive: true, force: true }))));

  // What a Gemini install leaves behind, recorded the way the installer records
  // it. The fingerprints matter: an artifact whose hash does not match is held
  // back rather than removed, so a hand-written record would prove nothing.
  const extension = path.join(home, ".gemini", "extensions", "agents-can-communicate");
  const settings = path.join(home, ".gemini", "settings.json");
  await mkdir(extension, { recursive: true });
  await writeFile(path.join(extension, "gemini-extension.json"), '{"name":"acc"}\n');
  await writeFile(settings, '{"theme":"dark"}\n');
  await recordInstall({ dataHome, adapterId: "gemini_cli", version: "0.55.1",
    artifacts: [{ path: extension, kind: "tree" }, { path: settings, kind: "merge" }] });

  const { data, error } = await runInstallCommand({
    options: { home, adapter: "gemini_cli", yes: true },
    runtime: { platform: process.platform,
      env: { HOME: home, ACC_DATA_HOME: dataHome } },
    action: "uninstall" });

  assert.equal(error ?? null, null);
  const operation = data.plan.operations.find(one => one.adapterId === "gemini_cli");
  if (operation?.clientPresent === true) {
    // Gemini CLI is on this machine, so the case this test is about did not run.
    // Said out loud rather than passed quietly on a false premise.
    t.skip("Gemini CLI is installed here, so the client never left the machine");
    return;
  }

  assert.equal(operation?.clientPresent, false,
    "the record was not consulted, so this install cannot be removed by anything");
  await assert.rejects(readFile(path.join(extension, "gemini-extension.json")),
    "the recorded tree survived the uninstall");
  assert.equal((await readFile(settings, "utf8")).includes("theme"), true,
    "the user's own file did not survive");
});

test("uninstall counts the adapters it changed, not the ones it visited", async () => {
  const { actedOn } = await import("../src/install-command.mjs");

  // Three clients on the machine, none of them ever written to by ACC: the
  // adapter's uninstall runs and finds nothing, which is not an uninstall.
  assert.equal(actedOn({ action: "uninstall", operations: [
    { adapterId: "claude_code", applied: true, removed: [], changes: [] },
    { adapterId: "codex", applied: true, removed: [], changes: [] },
    { adapterId: "kimi", applied: true, removed: [], changes: [] }] }), 0);

  assert.equal(actedOn({ action: "uninstall", operations: [
    { adapterId: "gemini_cli", applied: true, removed: ["/a/tree"], changes: [] },
    { adapterId: "kimi", applied: true, removed: [], changes: ["unpicked an entry"] },
    { adapterId: "codex", applied: true, removed: [], changes: [] }] }), 2);

  // An install that ran wrote something by definition, so it is counted as it was.
  assert.equal(actedOn({ action: "install", operations: [
    { adapterId: "kimi", applied: true, removed: [], changes: [] },
    { adapterId: "codex", applied: false }] }), 1);
});

test("a removal can be previewed, the same way an install can", async t => {
  const { parseArgs } = await import("../src/args.mjs");
  // The preview was computed for either action from the start, and only
  // `install` had a flag to ask for it - an operation the product could do and
  // nothing could reach.
  assert.equal(parseArgs(["uninstall", "--dry-run"]).options.dryRun, true);

  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-dry-home-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-dry-data-")));
  t.after(() => Promise.all([home, dataHome]
    .map(dir => rm(dir, { recursive: true, force: true }))));

  const extension = path.join(home, ".gemini", "extensions", "agents-can-communicate");
  await mkdir(extension, { recursive: true });
  await writeFile(path.join(extension, "gemini-extension.json"), '{"name":"acc"}\n');
  await recordInstall({ dataHome, adapterId: "gemini_cli", version: "0.55.1",
    artifacts: [{ path: extension, kind: "tree" }] });

  const { text } = await runInstallCommand({
    options: { home, adapter: "gemini_cli", dryRun: true },
    runtime: { platform: process.platform,
      env: { HOME: home, ACC_DATA_HOME: dataHome } },
    action: "uninstall" });

  assert.match(text, /^would uninstall:/);
  assert.match(text, new RegExp(`remove ${extension}`));
  // The whole point of a preview.
  assert.equal((await readFile(path.join(extension, "gemini-extension.json"), "utf8"))
    .includes("acc"), true, "the dry run removed the thing it was previewing");
});
