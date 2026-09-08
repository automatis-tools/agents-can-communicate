import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

const run = promisify(execFile);

test("installed update reports failed steps as failures and preserves successful activation instructions", async t => {
  const p = await createPackedAcc(t);
  const bin = path.join(p.root, "update-bin"), trace = path.join(p.root, "update-trace.jsonl");
  await mkdir(bin);
  const bootstrap = path.join(p.root, "registry-response.mjs");
  await writeFile(bootstrap, 'globalThis.fetch = async () => ({ ok: true, json: async () => ({ version: "99.0.0" }) });\n');
  for (const command of ["npm", "acc"]) {
    await writeFile(path.join(bin, command), `#!${process.execPath}\n`
      + 'const fs = require("node:fs");\n'
      + `fs.appendFileSync(process.env.ACC_UPDATE_TRACE, JSON.stringify({ command: ${JSON.stringify(command)}, args: process.argv.slice(2) }) + "\\n");\n`
      + `if (process.env.ACC_UPDATE_FAIL === ${JSON.stringify(command)}) { console.error("fixture step refused"); process.exit(23); }\n`
      + (command === "acc" ? 'console.log("ACTIVATION_SENTINEL: trust the refreshed hooks, then restart the client");\n' : ''),
    { mode: 0o755 });
  }
  const invoke = async ({ args = [], failure = "", json = true } = {}) => {
    await writeFile(trace, "");
    const env = { ...p.env, PATH: bin, ACC_NO_UPDATE_CHECK: "0",
      ACC_UPDATE_TRACE: trace, ACC_UPDATE_FAIL: failure };
    const argv = ["--import", bootstrap, p.accBin, "update", ...args,
      ...(json ? ["--json"] : [])];
    const result = await run(process.execPath, argv, { env, cwd: p.project })
      .then(output => ({ code: 0, ...output }), e => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
    const calls = (await readFile(trace, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    return { ...result, calls, response: json ? JSON.parse(result.stdout) : null };
  };
  for (const failedStep of ["npm", "acc"]) {
    const result = await invoke({ args: ["--apply"], failure: failedStep });
    assert.equal(result.code, 4, `${failedStep} failed but update exited successfully`);
    assert.equal(result.response.ok, false);
    assert.match(result.response.error.message, /fixture step refused/);
    assert.equal(result.response.error.details.failed.startsWith(failedStep + " "), true);
    assert.equal(result.response.error.details.applied.length, failedStep === "npm" ? 0 : 1);
    assert.deepEqual(result.calls.map(c => c.command), failedStep === "npm" ? ["npm"] : ["npm", "acc"]);
    assert.doesNotMatch(result.stdout, /updated to 99\.0\.0/);
  }
  const failedHuman = await invoke({ args: ["--apply"], failure: "acc", json: false });
  assert.equal(failedHuman.code, 4);
  assert.match(failedHuman.stderr, /fixture step refused/);
  assert.match(failedHuman.stderr, /finish it with:\n  acc install/);
  assert.doesNotMatch(failedHuman.stderr, /finish it with:\n  npm/);
  const applied = await invoke();
  assert.equal(applied.code, 0);
  assert.equal(applied.response.ok, true);
  assert.deepEqual(applied.calls.map(call => call.command), ["npm", "acc"]);
  assert.match(applied.response.data.installation.stdout, /ACTIVATION_SENTINEL/);
  assert.match(applied.response.data.activation, /Restart all running agent clients/);
  assert.deepEqual(applied.calls, [
    { command: "npm", args: ["install", "--global", "agents-can-communicate@99.0.0"] },
    { command: "acc", args: ["install"] },
  ]);
  const checked = await invoke({ args: ["--check"] });
  assert.equal(checked.code, 0);
  assert.equal(checked.response.ok, true);
  assert.equal(checked.response.data.newer, true);
  assert.deepEqual(checked.calls, []);

  const conflicting = await invoke({ args: ["--check", "--apply"] });
  assert.equal(conflicting.code, 2);
  assert.equal(conflicting.response.ok, false);
  assert.deepEqual(conflicting.calls, []);

  const human = await invoke({ json: false });
  assert.equal(human.code, 0);
  assert.match(human.stdout, /ACTIVATION_SENTINEL/);
  assert.match(human.stdout, /restart/i);
});
