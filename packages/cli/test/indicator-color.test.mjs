import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import test from "node:test";
import { createIndicatorFixture } from "../../../tests/helpers/indicator-fixture.mjs";

async function run(f, args = []) {
  const child = promisify(execFile)(process.execPath,
    [path.resolve(import.meta.dirname, "../../../bin/acc-indicator.mjs"), "--adapter", "antigravity", ...args],
    { env: { ...process.env, ACC_DATA_HOME: f.dataHome }, timeout: 3000 });
  child.child.stdin.end(JSON.stringify({ conversation_id: "native-session" }));
  return (await child).stdout;
}

test("Antigravity timeout diagnostics stay plain in details mode", async t => {
  const f = await createIndicatorFixture(t, { adapterId: "antigravity", version: "1.3.2" });
  const child = promisify(execFile)(process.execPath,
    [path.resolve(import.meta.dirname, "../../../bin/acc-indicator.mjs"), "--adapter", "antigravity", "--details"],
    { env: { ...process.env, ACC_DATA_HOME: f.dataHome }, timeout: 4000 });
  // Leave stdin open: the renderer must stop waiting and explain the failure.
  const { stdout } = await child;
  assert.equal(stdout.includes("\x1b"), false);
  assert.match(stdout, /acc doctor/);
});

test("the piped Antigravity callback colors only its healthy dot without a background", async t => {
  const f = await createIndicatorFixture(t, { adapterId: "antigravity", version: "1.3.2" });
  await f.service.publishDeliveryBinding(f.binding);
  await f.attempt("active");
  const output = await run(f);
  assert.equal(stripVTControlCharacters(output), "ACC ●\n");
  assert.deepEqual(output.split(/\x1b\[[0-9;]*m/g), ["ACC ", "●", "\n"]);
  // A foreground truecolor sequence and its foreground/intensity reset only.
  // These literal colors are independent of the renderer and catch gray output.
  assert.deepEqual(output.match(/\x1b\[[0-9;]*m/g),
    ["\x1b[22;1;38;2;44;122;57m", "\x1b[22;39m"]);
  const json = await run(f, ["--json"]);
  assert.equal(json.includes("\x1b"), false);
  assert.equal(JSON.parse(json).label, "ACC ●");
  const details = await run(f, ["--details"]);
  assert.equal(details.includes("\x1b"), false);
});

test("an Antigravity failure colors only the exclamation mark and keeps the fallback plain", async t => {
  const f = await createIndicatorFixture(t, { adapterId: "antigravity", version: "1.3.2" });
  await f.attempt("degraded", "handshake_failed");
  const output = await run(f);
  assert.equal(stripVTControlCharacters(output), "ACC ! · turn · acc doctor\n");
  assert.deepEqual(output.split(/\x1b\[[0-9;]*m/g), ["ACC ", "!", " · turn · acc doctor\n"]);
  assert.deepEqual(output.match(/\x1b\[[0-9;]*m/g),
    ["\x1b[22;1;38;2;150;108;30m", "\x1b[22;39m"]);
});
