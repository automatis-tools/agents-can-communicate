import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import test from "node:test";
import { parseArgs } from "../src/args.mjs";
import { installClaudePlugin, uninstallClaudePlugin } from "../../adapter-claude-code/src/install.mjs";
import { installAntigravity, uninstallAntigravity, ACC_REGISTERED_EVENTS }
  from "../../adapter-antigravity/src/install.mjs";
import { fakeAgy } from "../../adapter-antigravity/test/fake-agy.mjs";
import { configureIndicator } from "../../adapter-antigravity/src/indicator-install.mjs";
import { planInstallation } from "../../installer/src/plan.mjs";

const exec = promisify(execFile);
const json = async file => JSON.parse(await readFile(file, "utf8"));
async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "acc-indicator-install-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, dataHome: path.join(home, "data"), configDir: path.join(home, ".claude"),
    indicator: "on", clientVersion: "2.1.295", runAgy: fakeAgy().run,
    probeHooks: async () => ({ hooks: [{ name: "acc", enabled: true,
      actions: ACC_REGISTERED_EVENTS.map(event => ({ event })) }] }) };
}

test("install accepts an explicit indicator preference", () => {
  assert.equal(parseArgs(["install", "--indicator", "on"]).options.indicator, "on");
  assert.equal(parseArgs(["install", "--indicator", "off"]).options.indicator, "off");
});

test("install and update preserve the indicator preference and report unsupported surfaces", () => {
  const adapter = { id: "fixture", displayName: "Fixture client", planInstall: () => [] };
  const input = { adapters: [adapter], context: {},
    detected: [{ adapterId: "fixture", present: true, version: "1.0.0" }],
    recorded: [{ adapterId: "fixture", indicator: "on" }] };
  assert.equal(planInstallation(input).operations[0].indicator, "on");
  assert.equal(planInstallation({ ...input, indicator: "off" }).operations[0].indicator, "off");
  assert.match(planInstallation(input).operations[0].summary.join("\n"), /indicator.*not supported/i);
});

test("Claude adds its module without taking the user's statusLine; disabling removes only the module", async t => {
  const context = await fixture(t);
  await mkdir(context.configDir, { recursive: true });
  const file = path.join(context.configDir, "settings.json");
  const existing = { statusLine: { type: "command", command: "my-status", padding: 2 } };
  await writeFile(file, JSON.stringify(existing));
  await installClaudePlugin(context);
  const source = path.join(context.configDir, "plugins", "marketplaces", "acc-local", "agents-can-communicate");
  const hooks = path.join(source, "hooks", "hooks.json");
  assert.deepEqual((await json(hooks)).modules, ["./indicator.mjs"]);
  assert.deepEqual((await json(file)).statusLine, existing.statusLine);
  await installClaudePlugin({ ...context, indicator: "off" });
  assert.equal((await json(hooks)).modules, undefined);
  assert.deepEqual((await json(file)).statusLine, existing.statusLine);
  await uninstallClaudePlugin(context);
  assert.deepEqual(await json(file), existing);
});

test("Antigravity preserves and runs an existing status command and restores it on disable", async t => {
  const context = await fixture(t);
  const file = path.join(context.home, ".gemini", "antigravity-cli", "settings.json");
  await mkdir(path.dirname(file), { recursive: true });
  const previousScript = path.join(context.home, "previous.mjs");
  await writeFile(previousScript, `let text=''; for await(const chunk of process.stdin) text+=chunk;\n`
    + `process.stdout.write('user-status:'+JSON.parse(text).session_id);\n`);
  const old = { type: "command", command: `"${process.execPath}" "${previousScript}"`,
    padding: 2, stack_with_default: false };
  await writeFile(file, JSON.stringify({ statusLine: old, theme: "dark" }));
  await installAntigravity(context);
  const installed = (await json(file)).statusLine;
  assert.notEqual(installed.command, old.command, "the installed command must include ACC");
  // Execute the installed artifact with the same session payload the client supplies.
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e",
    `import {spawn} from 'node:child_process'; const p=spawn(process.argv[1],{shell:true,env:process.env}); p.stdout.pipe(process.stdout); p.stdin.end('{"session_id":"absent"}');` , installed.command],
  { env: { ...process.env, ACC_DATA_HOME: context.dataHome }, timeout: 5000 });
  assert.match(stripVTControlCharacters(stdout), /^user-status:absent\nACC !/);
  assert.match(stdout, /ACC \x1b\[[0-9;]+m!\x1b\[22;39m/);
  await installAntigravity(context);
  assert.equal((await json(file)).statusLine.command, installed.command, "reinstall must not nest wrappers");
  await installAntigravity({ ...context, indicator: "off" });
  assert.deepEqual((await json(file)).statusLine, old);
  assert.equal((await json(file)).theme, "dark");
});

test("Antigravity updates and uninstall keep a status command the user changed after installation", async t => {
  const context = await fixture(t);
  await installAntigravity(context);
  const file = path.join(context.home, ".gemini", "antigravity-cli", "settings.json");
  const changed = { type: "command", command: "my-new-status" };
  await writeFile(file, JSON.stringify({ ...(await json(file)), statusLine: changed }));
  for (let update = 0; update < 2; update++) {
    await installAntigravity({ ...context, indicatorRunner: path.join(context.home, `runner-${update}.mjs`) });
    assert.deepEqual((await json(file)).statusLine, changed);
  }
  await uninstallAntigravity(context);
  assert.deepEqual((await json(file)).statusLine, changed);
});

for (const removeFile of [false, true]) {
  test(`Antigravity updates keep a user-removed ${removeFile ? "settings file" : "statusLine"} absent`, async t => {
    const context = await fixture(t);
    const file = path.join(context.home, ".gemini", "antigravity-cli", "settings.json");
    await configureIndicator(context, true);
    if (removeFile) await rm(file);
    else await writeFile(file, JSON.stringify({ theme: "dark" }));
    for (const enabled of [true, true, false]) {
      await configureIndicator(context, enabled);
      if (removeFile) await assert.rejects(readFile(file), { code: "ENOENT" });
      else assert.deepEqual(await json(file), { theme: "dark" });
    }
  });
}

test("Antigravity disable preserves a replacement and explicit re-enable composes it anew", async t => {
  const context = await fixture(t);
  const file = path.join(context.home, ".gemini", "antigravity-cli", "settings.json");
  await configureIndicator(context, true);
  const changed = { type: "command", command: "my-new-status", enabled: false, padding: 3 };
  await writeFile(file, JSON.stringify({ statusLine: changed, theme: "dark" }));
  for (const enabled of [true, true, false, false]) {
    await configureIndicator(context, enabled);
    assert.deepEqual(await json(file), { statusLine: changed, theme: "dark" });
  }
  await configureIndicator(context, true);
  assert.notEqual((await json(file)).statusLine.command, changed.command);
  await configureIndicator(context, false);
  assert.deepEqual(await json(file), { statusLine: changed, theme: "dark" });
});

test("refresh never claims status-line presentation fields the user edited", async t => {
  const context = await fixture(t);
  const file = path.join(context.home, ".gemini", "antigravity-cli", "settings.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ statusLine: { type: "command", command: "my-status", padding: 2 } }));
  await configureIndicator(context, true);
  const edited = await json(file);
  edited.statusLine.padding = 3;
  edited.statusLine.stack_with_default = false;
  edited.statusLine.enabled = false;
  await writeFile(file, JSON.stringify(edited));
  for (let update = 0; update < 2; update++) {
    const indicatorRunner = path.join(context.home, `runner-${update}.mjs`);
    const expected = `refreshed-indicator-${update}`;
    await writeFile(indicatorRunner, `process.stdout.write(${JSON.stringify(expected)});\n`);
    await configureIndicator({ ...context, indicatorRunner }, true);
    const statusLine = (await json(file)).statusLine;
    const { stdout } = await exec(process.execPath, ["--input-type=module", "-e",
      `import {spawn} from 'node:child_process'; const p=spawn(process.argv[1],{shell:true,stdio:['ignore','pipe','inherit']}); p.stdout.pipe(process.stdout); p.on('exit',code=>{process.exitCode=code??1});`,
      statusLine.command], { env: { ...process.env, ACC_DATA_HOME: context.dataHome }, timeout: 5000 });
    assert.equal(stdout, expected, "refresh must execute the updated runner");
    assert.deepEqual({ ...statusLine, command: edited.statusLine.command }, edited.statusLine);
  }
  await configureIndicator(context, false);
  assert.deepEqual((await json(file)).statusLine,
    { type: "command", command: "my-status", padding: 3, stack_with_default: false, enabled: false });
});

test("an Antigravity version below the status-line floor keeps its existing command", async t => {
  const context = await fixture(t);
  const file = path.join(context.home, ".gemini", "antigravity-cli", "settings.json");
  await mkdir(path.dirname(file), { recursive: true });
  const statusLine = { type: "command", command: "user-status" };
  await writeFile(file, JSON.stringify({ statusLine }));
  await installAntigravity({ ...context, clientVersion: "1.0.5" });
  assert.deepEqual((await json(file)).statusLine, statusLine);
});
