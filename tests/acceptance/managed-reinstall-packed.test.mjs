import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createPackedAcc } from "../helpers/packed-acc.mjs";

const stateFile = f => path.join(f.dataHome, "acc", "runtime", "control.json");
const readState = f => readFile(stateFile(f), "utf8").then(JSON.parse);
const install = (f, adapter = "codex") => f.acc(["install", "--adapter", adapter, "--delivery", "off"]);
const uninstall = f => f.acc(["uninstall", "--adapter", "codex"]);

async function fixture(t) {
  const f = await createPackedAcc(t);
  await f.setClientVersions({ codex: "0.153.4", claude: "2.1.259" });
  await install(f);
  return f;
}

// Losing the choice during uninstall or preserving its temporary false on
// fresh enrollment must fail the actual installed command sequence.
test("packed reinstall restores automatic updates after repeated full uninstall", async t => {
  const f = await fixture(t);
  assert.equal((await readState(f)).auto, true);
  for (const legacy of [false, true]) {
    if (legacy) {
      const { autoPreference: _preference, ...oldSchema } = await readState(f);
      await writeFile(stateFile(f), JSON.stringify(oldSchema));
    }
    await uninstall(f);
    await uninstall(f);
    const removed = await readState(f);
    assert.equal(removed.auto, false, "uninstalled runtime must remain stopped");
    assert.deepEqual(removed.targets, []);
    assert.equal(removed.pending, null);
    await install(f);
    assert.equal((await f.acc(["doctor"])).update.auto, true,
      `${legacy ? "legacy enabled" : "fresh"} enrollment lost the automatic-update choice`);
  }
});

// A stale saved true must never resurrect an explicit opt-out, including a
// choice made while uninstalled; changing only a pin must not replace it.
test("packed reinstall honors explicit update choices and pin-only changes", async t => {
  const f = await fixture(t);
  await f.acc(["update", "--auto", "off"]);
  await install(f);
  assert.equal((await readState(f)).auto, false);
  await uninstall(f);
  await install(f);
  assert.equal((await readState(f)).auto, false, "full reinstall revoked explicit off");
  await f.acc(["update", "--auto", "on"]);
  assert.equal((await readState(f)).auto, true);
  await uninstall(f);
  await f.acc(["update", "--auto", "off"]);
  await f.acc(["update", "--pin", f.manifest.version]);
  await install(f);
  assert.equal((await readState(f)).auto, false, "off while uninstalled was forgotten");
  await f.acc(["update", "--auto", "on"]);
  await uninstall(f);
  await f.acc(["update", "--pin", "none"]);
  assert.equal((await readState(f)).auto, false, "pin-only change must keep uninstall paused");
  await install(f);
  const restored = await readState(f);
  assert.equal(restored.auto, true, "pin-only change erased the saved on choice");
  assert.equal(restored.pin, null);
});

// Old false records cannot distinguish explicit off from uninstall shutdown.
test("packed reinstall keeps ambiguous legacy automatic-update opt-outs", async t => {
  const f = await fixture(t);
  await uninstall(f);
  const { autoPreference: _preference, ...oldSchema } = await readState(f);
  await writeFile(stateFile(f), JSON.stringify(oldSchema));
  await install(f);
  assert.equal((await readState(f)).auto, false);
  await uninstall(f);
  await install(f);
  assert.equal((await readState(f)).auto, false);
});

// Restoring preference on every install resumes a failed removal when only an
// unrelated adapter was repaired. The real Codex preflight supplies the failure.
test("packed partial uninstall stays paused when another adapter is installed", async t => {
  const f = await fixture(t);
  await install(f, "claude_code");
  const config = path.join(f.clientHome, ".codex", "config.toml");
  const before = await readFile(config, "utf8");
  const ambiguous = before.replace("enabled = true", 'enabled = true\nunknown_option = "preserve"');
  assert.notEqual(ambiguous, before);
  await writeFile(config, ambiguous);
  const refused = await f.accError(["uninstall", "--adapter", "codex", "--adapter", "claude_code"]);
  assert.equal(refused?.code, 4);
  const failure = JSON.parse(refused.stdout).error.details.failed;
  assert.deepEqual(failure.map(item => item.adapterId), ["codex"]);
  const partial = await readState(f);
  assert.deepEqual(partial.targets, ["codex"]);
  assert.equal(partial.auto, false);
  await install(f, "claude_code");
  assert.equal((await readState(f)).auto, false, "unrelated install resumed failed removal");
  assert.equal(await readFile(config, "utf8"), ambiguous);
  await f.acc(["update", "--auto", "on"]);
  assert.equal((await readState(f)).auto, true, "explicit on must still allow recovery");
});
