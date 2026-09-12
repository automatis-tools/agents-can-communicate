import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

const run = promisify(execFile);
const captured = process.platform === "darwin" && process.arch === "arm64";
const human = (p, args) => run(process.execPath, [p.accBin, ...args],
  { cwd: p.project, env: p.env });
const terminal = async (p, args, answer) => {
  const child = spawn(process.execPath, ["--import",
    "data:text/javascript,process.stdin.isTTY=true;process.stdout.isTTY=true",
    p.accBin, ...args], { cwd: p.project, env: p.env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", answered = 0;
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    stdout += chunk;
    const prompts = (stdout.match(/\[y\/N\]/g) ?? []).length;
    while (answered < prompts) { child.stdin.write(`${answer}\n`); answered += 1; }
  });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const [code] = await new Promise((resolve, reject) => {
    child.once("error", reject); child.once("close", (...result) => resolve(result));
  });
  if (code !== 0) throw new Error(`terminal install exited ${code}: ${stderr}`);
  return { stdout, stderr };
};
const enableClaudeChannelProbe = async p => {
  const executable = path.join(p.clientBin, "claude");
  await writeFile(executable, '#!/bin/sh\n# notifications/claude/channel\nprintf "2.1.266 (Claude Code)\\n"\n');
  await chmod(executable, 0o755);
};
const enableManagedCodex = async p => {
  const commandLog = path.join(p.root, "codex-commands.log");
  const cli = path.join(p.clientBin, "codex");
  await writeFile(cli, `#!/bin/sh
printf '%s\\n' "$*" >> '${commandLog}'
case "$*" in
  --version) printf 'codex-cli 0.154.0\\n' ;;
  'app-server daemon --help') printf 'Commands:\\n  start Start\\n  stop Stop\\n  version Version\\n' ;;
  'app-server daemon start') exit 1 ;;
  *) exit 1 ;;
esac
`);
  await chmod(cli, 0o755);
  const managed = path.join(p.clientHome, ".codex", "packages", "standalone", "current", "bin");
  await mkdir(managed, { recursive: true });
  await symlink(cli, path.join(managed, "codex"));
  return commandLog;
};

test("packed CLI asks once for two clients and preserves complete setup decisions", {
  skip: !captured,
}, async t => {
  const p = await createPackedAcc(t);
  p.env.CODEX_HOME = path.join(p.clientHome, ".codex");
  p.env.SHELL = "/bin/zsh";
  await p.setClientVersions({ claude: "2.1.266", codex: "0.154.0" });
  await enableClaudeChannelProbe(p);
  const commandLog = path.join(p.root, "codex-commands.log");
  const codex = path.join(p.clientBin, "codex");
  await writeFile(codex, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${commandLog}'\nprintf 'codex-cli 0.154.0\\n'\n`);
  await chmod(codex, 0o755);
  const selected = ["install", "--adapter", "claude_code", "--adapter", "codex",
    "--home", p.clientHome];

  const accepted = await terminal(p, selected, "y");
  assert.equal((accepted.stdout.match(/\[y\/N\]/g) ?? []).length, 1);
  assert.match(accepted.stdout, /Claude Code, Codex CLI/);
  assert.match(accepted.stdout, /managed standalone installation/);
  const ownership = JSON.parse(await readFile(path.join(p.dataHome, "acc", "installs.json")));
  assert.deepEqual(Object.fromEntries(ownership.installs.map(entry => [entry.adapterId,
    [entry.deliveryPolicy, entry.deliveryDecision]])), {
    claude_code: ["actionable", { source: "interactive-accepted", completeSetup: true }],
    codex: ["actionable", { source: "interactive-accepted", completeSetup: true }],
  });
  assert.doesNotMatch(await readFile(commandLog, "utf8"), /app-server daemon start/);
  assert.match(await readFile(path.join(p.env.CODEX_HOME, "config.toml"), "utf8"), /acc-workspace/);

  const repeat = await terminal(p, selected, "n");
  assert.equal((repeat.stdout.match(/\[y\/N\]/g) ?? []).length, 0);
  const repeated = JSON.parse(await readFile(path.join(p.dataHome, "acc", "installs.json")));
  assert.ok(repeated.installs.every(entry => entry.deliveryDecision.completeSetup === true));
});

test("packed CLI refusal, explicit automation, and dry run keep their distinct effects", {
  skip: !captured,
}, async t => {
  const refused = await createPackedAcc(t);
  refused.env.CODEX_HOME = path.join(refused.clientHome, ".codex");
  refused.env.SHELL = "/bin/zsh";
  await refused.setClientVersions({ claude: "2.1.266", codex: "0.154.0" });
  await enableClaudeChannelProbe(refused);
  const refusedCommands = await enableManagedCodex(refused);
  const selected = ["install", "--adapter", "claude_code", "--adapter", "codex",
    "--home", refused.clientHome];
  await terminal(refused, selected, "n");
  const declined = JSON.parse(await readFile(path.join(refused.dataHome, "acc", "installs.json")));
  assert.ok(declined.installs.every(entry => entry.deliveryPolicy === "off"
    && entry.deliveryDecision.source === "interactive-declined"
    && entry.deliveryDecision.completeSetup === false));
  assert.doesNotMatch(await readFile(path.join(refused.env.CODEX_HOME, "config.toml"), "utf8"),
    /acc-workspace|unix_sockets/);
  assert.doesNotMatch(await readFile(refusedCommands, "utf8"), /app-server daemon start/);
  const refusedDoctor = await human(refused, ["doctor", "--home", refused.clientHome]);
  assert.match(refusedDoctor.stdout, /ACC outgoing grants are absent/);
  assert.equal(refusedDoctor.stdout.split("sender permissions unverified").length - 1, 1);

  const automated = await createPackedAcc(t);
  automated.env.CODEX_HOME = path.join(automated.clientHome, ".codex");
  automated.env.SHELL = "/bin/zsh";
  await automated.setClientVersions({ codex: "0.154.0" });
  const automatedCommands = await enableManagedCodex(automated);
  const args = ["install", "--adapter", "codex", "--delivery", "actionable",
    "--home", automated.clientHome];
  const preview = await human(automated, [...args, "--dry-run"]);
  assert.match(preview.stdout, /^would install:/);
  assert.doesNotMatch(await readFile(automatedCommands, "utf8"), /app-server daemon start/);
  await assert.rejects(readFile(path.join(automated.dataHome, "acc", "installs.json")),
    { code: "ENOENT" });
  const attempted = await human(automated, args).then(() => null, error => error);
  assert.equal(attempted?.code, 4);
  assert.match(await readFile(automatedCommands, "utf8"), /app-server daemon start/);
  const explicit = JSON.parse(await readFile(path.join(automated.dataHome, "acc", "installs.json")));
  assert.deepEqual(explicit.installs[0].deliveryDecision,
    { source: "explicit-option", completeSetup: true });
});

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
  const offAdapter = after.adapters.find(a => a.adapterId === "codex");
  assert.equal(offAdapter.nativeDelivery.policy, "off");
  assert.deepEqual(offAdapter.deliveryDecision,
    { source: "explicit-option", completeSetup: false });
  assert.match((await human(p, ["doctor"])).stdout, /decision: disabled by explicit option/);
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

  // Execute the shipped hook in separate processes. No vendor process is in
  // their ancestry, so enabled consent must explain the missing PID, while an
  // ordinary environment reports its absent launch policy independently.
  const payload = name => ({ hook_event_name: "SessionStart", session_id: name, cwd: p.project });
  delete p.env.ACC_NATIVE_DELIVERY_POLICY;
  await p.hook("claude_code", payload("no-consent"), { ACC_PARTICIPANT: "no-consent" });
  await p.hook("claude_code", payload("no-client-pid"), {
    ACC_PARTICIPANT: "no-client-pid", ACC_NATIVE_DELIVERY_POLICY: "actionable" });
  const sessions = (await p.acc(["doctor"])).adapters.find(a => a.adapterId === "claude_code")
    .nativeDelivery.sessions;
  assert.equal(sessions.find(s => s.participantId === "no-consent").lastAttempt.policyStatus, "missing");
  assert.equal(sessions.find(s => s.participantId === "no-client-pid").lastAttempt.reasonCode,
    "client_process_unknown");
  assert.match((await human(p, ["doctor"])).stdout, /client process could not be identified/);
  await p.hook("claude_code", { ...payload("no-client-pid"), hook_event_name: "SessionEnd" });
  assert.equal((await p.acc(["doctor"])).adapters.find(a => a.adapterId === "claude_code")
    .nativeDelivery.sessions.length, 1);
});
