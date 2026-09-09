import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

const run = promisify(execFile);
const captured = process.platform === "darwin" && process.arch === "arm64";
const human = (p, args) => run(process.execPath, [p.accBin, ...args],
  { cwd: p.project, env: p.env });

test("installed delivery setup preserves opt-in before a Codex service exists and explains fallback", async t => {
  const p = await createPackedAcc(t);
  p.env.CODEX_HOME = path.join(p.clientHome, ".codex");
  p.env.SHELL = "/bin/zsh";
  await p.setClientVersions({ codex: "0.153.4" });
  const preview = await human(p, ["install", "--adapter", "codex", "--dry-run"]);
  assert.match(preview.stdout, /live delivery: off/);
  await assert.rejects(readFile(path.join(p.clientHome, ".codex", "config.toml")), { code: "ENOENT" });
  // Use the shipped command and actual detection/planning/application. Only the
  // terminal answer is supplied by a port; no detection result is invented.
  const entry = pathToFileURL(path.join(p.installed, "node_modules",
    "@agents-can-communicate/cli/src/install-command.mjs")).href;
  const driver = path.join(p.root, "interactive-install.mjs");
  await writeFile(driver, `
    import { runInstallCommand } from ${JSON.stringify(entry)};
    const questions = [];
    const result = await runInstallCommand({ options: { adapter: "codex" },
      runtime: { env: process.env, cwd: process.cwd(), platform: process.platform,
        packageRoot: ${JSON.stringify(p.installed)}, version: async () => ${JSON.stringify(p.manifest.version)},
        isInteractive: () => true, confirm: async question => {
          questions.push(question); return true;
        } } });
    if (result.error) throw result.error;
    process.stdout.write(JSON.stringify({ ...result, questions }));
  `);
  const result = JSON.parse((await run(process.execPath, [driver],
    { cwd: p.project, env: p.env })).stdout);
  assert.equal(result.questions.length, captured ? 1 : 0,
    "a supported client with no running service must still offer to save consent");
  if (captured) {
    assert.match(preview.stdout, /interactive choices were not made/);
    assert.match(result.questions[0], /Codex CLI/);
    assert.match(result.questions[0], /tokens/);
    assert.match(result.questions[0], /acc inbox/);
    assert.doesNotMatch(result.questions[0], /messages still arrive|use next-turn hooks/);
  }
  const expectedPolicy = captured ? "actionable" : "off";
  const operation = result.data.operations[0];
  assert.equal(operation.livePolicy, expectedPolicy);
  assert.equal(operation.effectiveLivePolicy, "off");
  assert.equal(operation.nativeActivation, undefined);
  const ownership = JSON.parse(await readFile(path.join(p.dataHome, "acc", "installs.json")));
  assert.equal(ownership.installs[0].deliveryPolicy, expectedPolicy);
  await assert.rejects(readFile(path.join(p.env.CODEX_HOME,
    "app-server-control", "app-server-control.sock")), { code: "ENOENT" });
  assert.match(result.text, /Codex CLI.*live delivery/);
  assert.match(result.text, /fallback: acc inbox/);
  const doctor = await p.acc(["doctor"]);
  const native = doctor.adapters.find(a => a.adapterId === "codex").nativeDelivery;
  assert.equal(native.policy, expectedPolicy);
  assert.notEqual(native.runtime, "active");
  if (captured) {
    assert.equal(native.reasonCode, "native_endpoint_unavailable");
    assert.match((await human(p, ["doctor"])).stdout, /local delivery service is unavailable/);
  }

  await p.acc(["install", "--adapter", "codex", "--delivery", "off"]);
  const off = await human(p, ["install", "--adapter", "codex"]);
  assert.match(off.stdout, /Codex CLI.*live delivery: off/);
  assert.match(off.stdout, /fallback: acc inbox/);
  const after = await p.acc(["doctor"]);
  assert.equal(after.adapters.find(a => a.adapterId === "codex").nativeDelivery.policy, "off");
  if (captured) assert.ok(after.remediation.some(line =>
    line.includes("acc install --adapter codex --delivery actionable")));

  // A missing service is retryable; a version below the native minimum is not.
  await p.setClientVersions({ codex: "0.147.0" });
  const older = JSON.parse((await run(process.execPath, [driver],
    { cwd: p.project, env: p.env })).stdout);
  assert.equal(older.questions.length, 0);
  assert.equal(older.data.operations[0].livePolicy, "off");
  if (captured) assert.match(older.text, /fallback: next-turn hooks \(when enabled\) or acc inbox/);
});


test("doctor asks to complete missing launch setup before asking for a new session", async t => {
  const p = await createPackedAcc(t);
  p.env.CODEX_HOME = path.join(p.clientHome, ".codex");
  await p.setClientVersions({ claude: "2.1.266" });
  const executable = path.join(p.clientBin, "claude");
  await writeFile(executable, '#!/bin/sh\n# notifications/claude/channel\nprintf "2.1.266 (Claude Code)\\n"\n');
  p.env.SHELL = "/bin/bash";
  await p.acc(["install", "--adapter", "claude_code", "--delivery", "actionable"]);
  p.env.SHELL = "/bin/zsh";
  const before = (await p.acc(["doctor"])).adapters.find(a => a.adapterId === "claude_code");
  assert.equal(before.nativeDelivery.policy, "actionable");
  if (!captured) {
    assert.equal(before.nativeDelivery.eligibility, "unsupported");
    return;
  }
  assert.equal(before.nativeDelivery.eligibility, "eligible");
  assert.equal(before.nativeDelivery.activation, "missing");
  assert.ok(before.remediation.some(line => line.startsWith("acc install --adapter claude_code")),
    "a restart cannot create the missing launch shim or Channel configuration");
  await p.acc(["install", "--adapter", "claude_code"]);
  const after = (await p.acc(["doctor"])).adapters.find(a => a.adapterId === "claude_code");
  assert.equal(after.nativeDelivery.activation, "recorded");
  assert.equal(after.nativeDelivery.runtime, "waiting");
  assert.ok(after.remediation.some(line => /new terminal/.test(line)));
});
