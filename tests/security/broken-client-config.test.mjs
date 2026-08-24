import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile }
  from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { ALL_ADAPTERS, clientContext } from "@agents-can-communicate/cli";
import { describeOutcome, failureOf }
  from "../../packages/cli/src/install-command.mjs";
import { EXIT } from "@agents-can-communicate/protocol";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const acc = path.join(repo, "bin", "acc.mjs");

/**
 * Installing over a config the client itself cannot read.
 *
 * Every adapter refused, which is right, and every one of them refused *after*
 * laying its plugin tree down. So a malformed `~/.claude/settings.json` left
 * nineteen files behind, no ownership recorded, and an uninstall that hit the
 * same file and refused too - a directory the user had to find and delete by
 * hand, whose name nothing had told them.
 *
 * And `acc install` said `installed 0 adapter(s); 1 failed` and exited 0. A
 * script, a CI step, or an agent running the installer was told it had worked.
 */
const CONFIGS = Object.freeze({
  claude_code: ".claude/settings.json",
  gemini_cli: ".gemini/settings.json",
  kimi: ".kimi-code/plugins/installed.json",
  codex: ".agents/plugins/marketplace.json",
});
const BROKEN = '{ "enabledPlugins": ';

async function home(t, { broken } = {}) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-badcfg-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { ...process.env, ACC_DATA_HOME: path.join(base, "data"),
    GIT_DIR: "", GIT_WORK_TREE: "" };
  const place = path.join(base, "home");
  await mkdir(place, { recursive: true });
  if (broken !== undefined) {
    await mkdir(path.join(place, path.dirname(broken)), { recursive: true });
    await writeFile(path.join(place, broken), BROKEN);
  }
  const cli = (...argv) => run(process.execPath, [acc, ...argv, "--home", place, "--yes"],
    { env });
  const ours = async () => (await readdir(place, { recursive: true }))
    .filter(entry => entry.includes("agents-can-communicate"));
  return { base, place, env, cli, ours };
}

for (const [adapterId, config] of Object.entries(CONFIGS)) {
  test(`${adapterId}: a config it cannot read leaves nothing behind`, async t => {
    const place = await home(t, { broken: config });
    const adapter = ALL_ADAPTERS().find(item => item.id === adapterId);

    // The adapter directly, not `acc install`: what is under test is what gets
    // written, not which clients happen to be on the machine running this.
    const failure = await adapter.install(clientContext(place.place))
      .then(() => null, error => error);

    assert.notEqual(failure, null, `${adapterId} installed over a config it cannot read`);
    assert.match(failure.message, /is not valid JSON/);
    assert.match(failure.message, new RegExp(path.basename(config)));
    assert.deepEqual(await place.ours(), [],
      `${adapterId} wrote its files and then refused`);
    assert.equal(await readFile(path.join(place.place, config), "utf8"), BROKEN,
      "the file the user has to fix was rewritten");
  });
}

test("a failed adapter ends the command", async () => {
  // Asserted here rather than by running `acc install`: that acts only on
  // clients it can find on the machine, and a test that quietly does nothing
  // wherever none are installed - every CI runner - proves nothing at all.
  const failure = failureOf({ action: "install", acted: 1,
    failed: [{ adapterId: "claude_code", error: "settings.json is not valid JSON" }] });

  assert.notEqual(failure, null, "a script would be told the install had worked");
  assert.equal(failure.code, EXIT.DATA);
  assert.match(failure.message, /claude_code: settings\.json is not valid JSON/);
});

test("an outcome with nothing wrong is not an error", async () => {
  assert.equal(failureOf({ action: "install", acted: 2, failed: [] }), null);
});

test("the report says why nothing happened", async () => {
  // `installed 0 adapter(s)` was the whole answer whether four clients were
  // absent, one refused, or nothing was asked for. Both reasons existed and
  // only `--json` showed them.
  const text = describeOutcome({ action: "install", acted: 0,
    skipped: [{ adapterId: "kimi", reason: "Kimi Code is not installed on this machine" }],
    failed: [{ adapterId: "codex", error: "marketplace.json is not valid JSON" }] });

  assert.match(text, /skip kimi: Kimi Code is not installed/);
  assert.match(text, /codex: marketplace\.json is not valid JSON/);
});
