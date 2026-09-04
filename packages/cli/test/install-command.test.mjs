import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { recordInstall } from "@agents-can-communicate/installer";
import { EXIT } from "@agents-can-communicate/protocol";

import { PassThrough } from "node:stream";

import { askConfirmation } from "../src/confirm.mjs";
import { decideDelivery, runInstallCommand } from "../src/install-command.mjs";

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
  assert.equal(actedOn({ action: "uninstall", operations: [
    { adapterId: "kimi", applied: true, removed: [], removedDirectories: ["/empty"],
      changes: [] }] }), 1, "removing an ACC-created parent was reported as no change");

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

test("a command that wrote into someone's home says what it wrote", async () => {
  const { describeOutcome } = await import("../src/install-command.mjs");
  const home = "/Users/someone";
  const text = describeOutcome({ action: "install", acted: 1, home, operations: [{
    adapterId: "claude_code", action: "install", applied: true, artifacts: [
      { path: `${home}/.claude/plugins/cache/acc-local`, kind: "tree" },
      { path: `${home}/.claude/settings.json`, kind: "merge" }] }] });

  // `installed 1 adapter(s)` was the whole account of a command that had just
  // written into another tool's configuration inside someone's home.
  assert.equal(text, ["installed 1 adapter(s)",
    "  created ~/.claude/plugins/cache/acc-local",
    "  edited  ~/.claude/settings.json",
    "",
    "undo with: acc uninstall"].join("\n"));
});

test("an uninstall says what it removed and what it would not", async () => {
  const { describeOutcome } = await import("../src/install-command.mjs");
  const home = "/Users/someone";
  const text = describeOutcome({ action: "uninstall", acted: 1, home, operations: [{
    adapterId: "claude_code", action: "uninstall", applied: true,
    artifacts: [{ path: `${home}/.claude/settings.json`, kind: "merge" }],
    // What the adapter actually took out of those merge files. A run that
    // removed ACC's plugin tree took its settings entries out too, and the
    // `edited` line is reported from this rather than from the plan - see
    // uninstall-reports-only-what-changed.test.mjs.
    changes: ["enabledPlugins/agents-can-communicate@acc-local"],
    removed: [`${home}/.claude/plugins/cache/acc-local`],
    kept: [`${home}/.claude/plugins/marketplaces/acc-local`] }] });

  // What was held back is the line that matters: those bytes stopped matching
  // what ACC wrote, so they are someone's now and were left alone.
  assert.equal(text, ["uninstalled 1 adapter(s)",
    "  removed ~/.claude/plugins/cache/acc-local",
    "  edited  ~/.claude/settings.json",
    "  kept    ~/.claude/plugins/marketplaces/acc-local - changed since ACC wrote it",
  ].join("\n"));
});

test("nothing done is still reported as nothing done", async () => {
  const { describeOutcome } = await import("../src/install-command.mjs");

  assert.equal(describeOutcome({ action: "uninstall", acted: 0, operations: [
    { adapterId: "kimi", action: "uninstall", applied: true, artifacts: [],
      removed: [], kept: [] }],
    skipped: [{ adapterId: "gemini_cli", reason: "Gemini CLI is not installed" }] }),
  ["uninstalled 0 adapter(s)",
    "  skip gemini_cli: Gemini CLI is not installed"].join("\n"));
});

test("`--yes` is gone from the commands that never asked", async () => {
  const { parseArgs } = await import("../src/args.mjs");
  // It agreed to nothing: neither command has ever had a confirmation to skip,
  // and the flag was read by no code at all.
  for (const command of ["install", "uninstall"]) {
    assert.throws(() => parseArgs([command, "--yes"]),
      error => error.code === EXIT.USAGE && error.message.includes("--yes"), command);
  }
  // `config init` does ask, so there it still means something.
  assert.equal(parseArgs(["config", "init", "--yes"]).options.yes, true);
});

test("the install tells an adapter where ACC keeps its state", async t => {
  const { chmod, mkdir: makeDir } = await import("node:fs/promises");
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-state-home-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-state-data-")));
  t.after(() => Promise.all([home, dataHome]
    .map(dir => rm(dir, { recursive: true, force: true }))));

  // A client of this test's own, so it asks the same question everywhere. On the
  // real PATH, because detection spawns the client's binary and a spawn
  // inherits the process environment - passing a PATH in `runtime.env` looked
  // like it worked here and found nothing on a machine without Codex.
  const bin = path.join(home, "bin");
  await makeDir(bin, { recursive: true });
  await writeFile(path.join(bin, "codex"), "#!/bin/sh\necho \"codex-cli 0.147.0\"\n");
  await chmod(path.join(bin, "codex"), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous}`;
  t.after(() => { process.env.PATH = previous; });

  await runInstallCommand({
    options: { home, adapter: "codex" },
    runtime: { platform: process.platform,
      env: { ...process.env, HOME: home, ACC_DATA_HOME: dataHome,
        ACC_PROBE_TIMEOUT_MS: "30000" } },
    action: "install" });

  // Codex sandboxes what a model runs to the workspace, and ACC's state is
  // outside every workspace by design - so an adapter that is never told where
  // that state is cannot declare it, and an agent there writes nothing.
  const config = await readFile(path.join(home, ".codex", "config.toml"), "utf8");
  assert.match(config, /\[sandbox_workspace_write\]/);
  assert.match(config, new RegExp(`writable_roots = \\["${dataHome}/acc"\\]`));
});

test("the status line says when the sessions it counts are not answering", async () => {
  const { describePresence } = await import("../src/main.mjs");

  // `live` counts everyone present, and a session goes stale rather than
  // vanishing when its client exits without closing it. The number alone said
  // "1 live" about a workspace whose last agent had left minutes before -
  // measured, by running a real client and watching what it left behind.
  assert.equal(describePresence({ live: 0, stale: 0 }), "0 live");
  assert.equal(describePresence({ live: 2, stale: 0 }), "2 live");
  assert.equal(describePresence({ live: 1, stale: 1 }), "1 present, none answering");
  assert.equal(describePresence({ live: 3, stale: 3 }), "3 present, none answering");
  assert.equal(describePresence({ live: 3, stale: 1 }), "3 live (1 not answering)");
  assert.equal(describePresence(), "0 live");
});

// The per-client consent decision, fed a finished detection report and fake
// ports, so what is asked and what is stored can be checked without a client.
const eligible = (adapterId, displayName, command) => ({ adapterId, displayName, present: true,
  version: "2.1.258", nativeDelivery: { state: "eligible", reasonCode: null,
    realExecutable: `/vendor/${command}`, probe: null,
    eligibility: { eligible: true, protocolContract: `${command}-native-v1` },
    activationPlan: { eligible: true, reasonCode: null, mechanisms: [{ kind: "shell-bootstrap",
      command, realExecutable: `/vendor/${command}`, prefixArgs: ["--captured"] }] } } });
const ineligible = adapterId => ({ adapterId, displayName: adapterId, present: true,
  version: "1.0.0", nativeDelivery: { state: "unsupported",
    reasonCode: "native_delivery_unsupported", activationPlan: null } });
const DETECTED = [eligible("claude_code", "Claude Code", "claude"),
  eligible("codex", "Codex", "codex"), ineligible("grok")];
const CONTEXT = { home: "/home/dana", stateRoot: "/data/acc", shell: "zsh" };
const neverAsk = { isInteractive: () => true,
  confirm: async () => { throw new Error("must not prompt"); } };
const decide = overrides => decideDelivery({ options: {}, detected: DETECTED, recorded: [],
  runtime: neverAsk, dryRun: false, context: CONTEXT, ...overrides });

test("an explicit delivery applies uniformly to the selected clients and never prompts", async () => {
  for (const delivery of ["actionable", "all", "off"]) {
    const decided = await decide({ options: { delivery } });
    assert.deepEqual(decided.deliveryByAdapter,
      { claude_code: delivery, codex: delivery, grok: delivery });
    assert.deepEqual(decided.asked, []);
  }
  await assert.rejects(decide({ options: { delivery: "sometimes" } }), /unknown delivery policy/);
});

test("delivery omitted without an interactive terminal installs off and asks nothing", async () => {
  const decided = await decide({ runtime: { isInteractive: () => false,
    confirm: async () => { throw new Error("must not prompt"); } } });
  assert.deepEqual(decided.deliveryByAdapter, { claude_code: "off", codex: "off", grok: "off" });
  assert.deepEqual(decided.asked, []);
  assert.deepEqual(decided.notes, []);
});

test("a dry run with delivery omitted previews off and says no choice was made", async () => {
  const recorded = [{ adapterId: "codex", nativeActivation: { livePolicy: "all",
    protocolContract: "codex-native-v1", mechanisms: [] } }];
  const decided = await decide({ dryRun: true, recorded });
  assert.deepEqual(decided.deliveryByAdapter, { claude_code: "off", codex: "all", grok: "off" });
  assert.match(decided.notes.join("\n"), /interactive choices were not made/);
  assert.deepEqual(decided.asked, []);
});

test("an interactive install asks one default-No question per eligible client", async () => {
  const questions = [];
  const answers = [true, false];
  const runtime = { isInteractive: () => true, input: "in", output: "out",
    confirm: async (question, io) => { questions.push([question, io]); return answers.shift(); } };
  const decided = await decide({ runtime });
  assert.deepEqual(decided.deliveryByAdapter, { claude_code: "actionable", codex: "off", grok: "off" });
  assert.deepEqual(decided.asked, ["claude_code", "codex"]);
  assert.equal(questions.length, 2, "the ineligible client is reported, not asked");
  const [first, io] = questions[0];

  // Written for someone who has never heard of this project. The old wording
  // opened with "Enable native live delivery" over a list of internal artefact
  // names, which told a first-time reader neither what they gained nor what it
  // cost. Each assertion below is one thing such a reader has to be told.
  assert.match(first, /^Let other agents reach Claude Code while it is working\?/,
    "the question does not say, in the reader's words, what it is asking for");

  // The loudest consequence, and the one the old prompt omitted entirely: their
  // own client will start with a flag its vendor calls dangerous.
  assert.match(first, /--captured flag to `claude`/,
    "consent that hides the flag it adds to the client's own launch is not consent");

  assert.match(first, /Writes: a launcher, a PATH line in ~\/\.zshrc\./,
    "paths under the reader's home are shortened; /home/dana is noise to them");
  assert.match(first, /Say no - messages still arrive next turn or via `acc inbox`/,
    "a default-No prompt must say that no costs the reader nothing");
  assert.match(first, /Undo: acc install --adapter claude_code --delivery off/,
    "the way back out belongs in the same breath as the way in");

  // Short enough to read at a prompt: nobody weighs a decision they skim past.
  const lines = first.split("\n");
  assert.ok(lines.length <= 5, `the question grew to ${lines.length} lines`);
  const longest = Math.max(...lines.map(line => line.length));
  assert.ok(longest <= 88, `a line reached ${longest} characters and will wrap`);
  assert.deepEqual(io, { input: "in", output: "out" });
});

test("a recorded opt-in is kept on upgrade without a new question", async () => {
  const recorded = [{ adapterId: "claude_code", nativeActivation: { livePolicy: "all",
    protocolContract: "claude-native-v1", mechanisms: [] } }];
  const asked = [];
  const runtime = { isInteractive: () => true, confirm: async question => {
    asked.push(question); return false;
  } };
  const decided = await decide({ recorded, runtime });
  assert.equal(decided.deliveryByAdapter.claude_code, "all");
  assert.equal(decided.deliveryByAdapter.codex, "off");
  assert.deepEqual(decided.asked, ["codex"]);
  assert.equal(asked.length, 1);
});

test("EOF and blank input mean No, and only an explicit yes means Yes", async () => {
  const ask = async text => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const pending = askConfirmation("Enable?", { input, output });
    if (text !== null) input.write(text);
    input.end();
    return pending;
  };
  assert.equal(await ask(null), false);
  assert.equal(await ask("\n"), false);
  assert.equal(await ask("   \n"), false);
  assert.equal(await ask("maybe\n"), false);
  assert.equal(await ask("y\n"), true);
  assert.equal(await ask("YES\n"), true);
});
