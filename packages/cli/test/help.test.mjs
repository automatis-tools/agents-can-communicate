import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { EXIT } from "@agents-can-communicate/protocol";

import { COMMANDS, parseArgs } from "../src/args.mjs";
import { describeCommands, helpText } from "../src/help.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const binary = path.join(repoRoot, "bin", "acc.mjs");

/**
 * The first two things anyone types after `npm install -g`.
 *
 * Both were "unknown command" in the package that was about to be published,
 * and no test noticed: every other test knew a command to run.
 */
test("the two first questions a person asks are commands", () => {
  for (const spelling of ["--help", "-h", "help"]) {
    assert.equal(parseArgs([spelling]).command, "help", spelling);
  }
  for (const spelling of ["--version", "-v", "-V", "version"]) {
    assert.equal(parseArgs([spelling]).command, "version", spelling);
  }
});

test("`acc` on its own says how to find the commands", () => {
  assert.throws(() => parseArgs([]),
    error => error.code === EXIT.USAGE && error.message.includes("acc help"));
  assert.throws(() => parseArgs(["teleport"]),
    error => error.code === EXIT.USAGE && error.message.includes("acc help"));
});

test("a message body may still be the word --help", () => {
  // The reason the spellings are read in first position only. Agents exchange
  // diffs and console output, and a body that begins with "--" is ordinary.
  const parsed = parseArgs(["message", "--to", "peer", "--subject", "s",
    "--body", "--help"]);

  assert.equal(parsed.command, "message");
  assert.equal(parsed.options.body, "--help");
});

test("the help lists every command the CLI accepts, and invents none", () => {
  const listed = describeCommands().flatMap(group => group.commands.map(one => one.name));

  assert.deepEqual([...listed].sort(), Object.keys(COMMANDS).sort(),
    "a command exists that the help does not mention, or the other way round");
  assert.equal(new Set(listed).size, listed.length, "a command appears under two headings");
  for (const name of listed) {
    assert.match(helpText(), new RegExp(`acc ${name}\\b`), `${name} is not in the text`);
  }
});

test("every listed command says what it does", () => {
  const missing = describeCommands().flatMap(group => group.commands)
    .filter(one => typeof one.summary !== "string" || one.summary === "")
    .map(one => one.name);

  assert.deepEqual(missing, [], "a command is listed with nothing said about it");
});

test("help and version answer even when the store cannot be opened", async t => {
  // They describe the program, not a workspace. Pointing the data home at a
  // file makes every command that opens the store fail, which is what proves
  // these two never reach it - rather than restating the routing table.
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-help-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const blocked = path.join(home, "not-a-directory");
  await writeFile(blocked, "");

  const run = argv => execFileAsync(process.execPath, [binary, ...argv],
    { cwd: home, env: { ...process.env, ACC_DATA_HOME: blocked, HOME: home } });

  await assert.rejects(run(["status"]), "a workspace command still opened the store");

  const help = await run(["help"]);
  assert.match(help.stdout, /acc claim/);
  const version = await run(["version"]);
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(version.stdout.trim(), manifest.version);
});

test("the reference the help points at is one the reader can actually reach", async () => {
  // It named `docs/CLI.md` first, which is not packed: `files` ships `bin/`,
  // `README.md`, `LICENSE` and `docs/CAPABILITIES.md`. Help that points into
  // the installed package has to point at something that is in it.
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const repository = manifest.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
  const [reference] = helpText().match(/https:\/\/\S+/) ?? [];

  assert.equal(typeof reference, "string", "the help offers nowhere to read more");
  assert.equal(reference.startsWith(repository), true,
    `the help points at ${reference}, which is not the repository the manifest names`);
  for (const shipped of manifest.files) {
    assert.equal(helpText().includes(` ${shipped}`), false,
      "the help names a packed path where a URL belongs");
  }
  assert.equal(/\bdocs\/(?!CAPABILITIES)/.test(helpText().replace(reference, "")), false,
    "the help names a document the installed package does not carry");
});

test("the version is the package's own, not one typed into the source", async () => {
  // `bin/` sits at the same depth in the published package as it does here, so
  // this relative read is the one thing that stays true in both layouts.
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const source = await readFile(binary, "utf8");

  assert.match(source, /\.\.\/package\.json/);
  assert.equal(source.includes(manifest.version), false,
    "the version is written into bin/acc.mjs, so the next bump will leave it behind");
});
