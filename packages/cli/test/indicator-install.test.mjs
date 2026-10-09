import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
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
  assert.match(stdout, /^user-status:absent\nACC !/);
  await installAntigravity(context);
  assert.equal((await json(file)).statusLine.command, installed.command, "reinstall must not nest wrappers");
  await installAntigravity({ ...context, indicator: "off" });
  assert.deepEqual((await json(file)).statusLine, old);
  assert.equal((await json(file)).theme, "dark");
});

test("Antigravity uninstall keeps a status command the user changed after installation", async t => {
  const context = await fixture(t);
  await installAntigravity(context);
  const file = path.join(context.home, ".gemini", "antigravity-cli", "settings.json");
  const changed = { type: "command", command: "my-new-status" };
  await writeFile(file, JSON.stringify({ ...(await json(file)), statusLine: changed }));
  await uninstallAntigravity(context);
  assert.deepEqual((await json(file)).statusLine, changed);
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
  await writeFile(file, JSON.stringify(edited));
  await configureIndicator(context, true);
  await configureIndicator(context, false);
  assert.deepEqual((await json(file)).statusLine,
    { type: "command", command: "my-status", padding: 3, stack_with_default: false });
});
