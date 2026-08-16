import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CONFIG_FILENAME, EXIT } from "@agents-can-communicate/protocol";

import { parseArgs } from "../src/args.mjs";
import { runConfigCommand } from "../src/config-command.mjs";

async function workspace(t) {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "acc-config-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const configPath = path.join(cwd, CONFIG_FILENAME);
  const read = () => readFile(configPath, "utf8");
  return { cwd, configPath, read };
}

const noPrompt = () => {
  throw new Error("the command asked a question it should not have asked");
};

test("the parser accepts the two subcommands and refuses anything else", () => {
  assert.equal(parseArgs(["config", "init"]).options.subcommand, "init");
  assert.equal(parseArgs(["config", "validate"]).options.subcommand, "validate");

  assert.throws(() => parseArgs(["config"]), error => error.code === EXIT.USAGE);
  assert.throws(() => parseArgs(["config", "delete"]), error => error.code === EXIT.USAGE);
  // Options still parse after the subcommand.
  assert.equal(parseArgs(["config", "init", "--yes"]).options.yes, true);
});

test("init previews the file and writes nothing until it is confirmed", async t => {
  const { cwd, read } = await workspace(t);
  const asked = [];

  const result = await runConfigCommand({ subcommand: "init", cwd,
    confirm: async question => { asked.push(question); return false; } });

  assert.equal(asked.length, 1, "the file was written without asking");
  assert.match(asked[0], /acc\.workspace\.json/);
  assert.equal(result.written, false);
  await assert.rejects(read(), error => error.code === "ENOENT");
});

test("init writes the previewed content once confirmed", async t => {
  const { cwd, read } = await workspace(t);

  const result = await runConfigCommand({ subcommand: "init", cwd,
    confirm: async () => true });

  assert.equal(result.written, true);
  const written = JSON.parse(await read());
  assert.equal(written.schemaVersion, 1);
  assert.match(written.workspaceId, /^workspace_/);
  // What was shown is what landed. A preview that differs from the write is
  // worse than no preview.
  assert.deepEqual(JSON.parse(result.preview), written);
});

test("non-interactive init refuses without an explicit yes", async t => {
  const { cwd, read } = await workspace(t);

  await assert.rejects(
    runConfigCommand({ subcommand: "init", cwd, interactive: false, confirm: noPrompt }),
    error => error.code === EXIT.USAGE && /--yes/.test(error.message));

  await assert.rejects(read(), error => error.code === "ENOENT");
});

test("non-interactive init with --yes writes without asking", async t => {
  const { cwd, read } = await workspace(t);

  const result = await runConfigCommand({ subcommand: "init", cwd,
    interactive: false, yes: true, confirm: noPrompt });

  assert.equal(result.written, true);
  assert.equal(JSON.parse(await read()).schemaVersion, 1);
});

test("init refuses to overwrite a config that already exists", async t => {
  const { cwd, configPath, read } = await workspace(t);
  const existing = `${JSON.stringify({ schemaVersion: 1,
    workspaceId: "workspace_theirs", displayName: "Theirs" }, null, 2)}\n`;
  await writeFile(configPath, existing);

  await assert.rejects(
    runConfigCommand({ subcommand: "init", cwd, yes: true, confirm: noPrompt }),
    error => error.code === EXIT.CONFLICT);

  // A team's committed identity is not something to replace on a typo.
  assert.equal(await read(), existing);
});

test("validate reads the config and changes nothing", async t => {
  const { cwd, configPath, read } = await workspace(t);
  const original = `${JSON.stringify({ schemaVersion: 1,
    workspaceId: "workspace_ok", roots: ["."] }, null, 2)}\n`;
  await writeFile(configPath, original);

  const result = await runConfigCommand({ subcommand: "validate", cwd, confirm: noPrompt });

  assert.equal(result.valid, true);
  assert.equal(result.config.workspaceId, "workspace_ok");
  assert.equal(await read(), original, "validate modified the file it was asked to read");
});

test("validate names what is wrong instead of failing vaguely", async t => {
  const { cwd, configPath } = await workspace(t);
  await writeFile(configPath, `${JSON.stringify({ schemaVersion: 1,
    workspaceId: "workspace_ok", sessions: [] })}\n`);

  await assert.rejects(runConfigCommand({ subcommand: "validate", cwd, confirm: noPrompt }),
    error => error.code === EXIT.DATA && /sessions/.test(error.message));
});

test("validate on a workspace with no config reports the defaults", async t => {
  const { cwd } = await workspace(t);

  const result = await runConfigCommand({ subcommand: "validate", cwd, confirm: noPrompt });

  // Config is optional, so "there isn't one" is a valid answer, not an error -
  // and the policy that applies is worth printing either way.
  assert.equal(result.valid, true);
  assert.equal(result.present, false);
  assert.equal(result.config.policy.claimMode, "advisory");
});

test("the generated config passes its own validation", async t => {
  const { cwd, read } = await workspace(t);
  await runConfigCommand({ subcommand: "init", cwd, yes: true, confirm: noPrompt });

  const result = await runConfigCommand({ subcommand: "validate", cwd, confirm: noPrompt });

  // The one round trip that matters: a tool whose own output it rejects is
  // worse than a tool with no init at all.
  assert.equal(result.valid, true);
  assert.equal(result.present, true);
  assert.equal(JSON.parse(await read()).workspaceId, result.config.workspaceId);
});
