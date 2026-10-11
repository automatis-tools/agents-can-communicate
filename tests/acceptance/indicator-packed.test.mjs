import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";
import test from "node:test";
import { createPackedAcc } from "../helpers/packed-acc.mjs";
import { createIndicatorFixture } from "../helpers/indicator-fixture.mjs";

const exec = promisify(execFile);
test("the installed indicator survives the initial package and its mod preserves native labels", async t => {
  const f = await createPackedAcc(t);
  await f.setClientVersions({ claude: "2.1.295" });
  const env = { ...f.env, ACC_NO_UPDATE_CHECK: "1" };
  await f.acc(["install", "--adapter", "claude_code", "--indicator", "on", "--delivery", "off"], env);
  const root = path.join(f.dataHome, "acc", "runtime");
  const plugin = path.join(f.clientHome, ".claude", "plugins", "cache", "acc-local",
    "agents-can-communicate", f.manifest.version);
  assert.deepEqual(JSON.parse(await readFile(path.join(plugin, "hooks", "hooks.json"), "utf8")).modules,
    ["./indicator.mjs"]);
  const module = await import(pathToFileURL(path.join(plugin, "hooks", "indicator.mjs")).href);
  await rm(f.installed, { recursive: true });
  const binary = path.join(root, "bin", "acc-indicator.mjs");
  const { stdout } = await exec(process.execPath,
    ["--permission", "--allow-fs-read=*", binary, "--adapter", "claude_code",
      "--native-session", "absent", "--json"], { env, cwd: f.project });
  assert.equal(JSON.parse(stdout).reasonCode, "not_registered");

  // Exercise our module's boundary with the vendor API. The process call runs
  // the real installed reader; only the UI and clock are supplied by the host.
  const handlers = new Map(), logs = [];
  module.register((event, filter, handler) => handlers.set(event,
    typeof filter === "function" ? filter : handler));
  let now = 10_000, tick;
  const $ = { session: { id: async () => "absent" },
    clock: { now: async () => now, every: (_ms, fn) => { tick = fn; } },
    command: { register: async () => {} },
    process: { run: async ([command, ...args]) => exec(command, args, { env, cwd: f.project }) },
    ui: { log: async line => logs.push(line), invalidate: () => {}, resolve: () => ({
      Box: props => ({ type: "Box", ...props }), Text: props => ({ type: "Text", ...props }),
    }) } };
  await handlers.get("session.start")($, {}, async e => e);
  now += 6000;
  await tick();
  const event = { props: { modes: ["existing-mode"] } };
  const native = { type: "engine", ref: "existing-mode" };
  const rendered = await handlers.get("ui.render")($, event, async passed => {
    assert.deepEqual(passed, event);
    return native;
  });
  assert.deepEqual(rendered.children[0], native);
  assert.equal(rendered.children.filter(node => node.type === "Text")
    .map(node => node.children.join("")).join(""), " ACC !");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /acc doctor/);
  now += 6000;
  await tick();
  assert.equal(logs.length, 1, "a stable failure must not print on each refresh");
  assert.match((await handlers.get("command.run")($)).text, /not registered.*\nSend a prompt/s);

  const stable = args => exec(process.execPath, [path.join(root, "bin", "acc.mjs"), ...args],
    { env, cwd: f.project });
  await stable(["install", "--adapter", "claude_code", "--indicator", "off", "--delivery", "off", "--home", f.clientHome]);
  assert.equal(JSON.parse(await readFile(path.join(plugin, "hooks", "hooks.json"), "utf8")).modules, undefined);
});

test("the installed Antigravity reader emits a colored glyph through a pipe with writes forbidden", async t => {
  const f = await createPackedAcc(t);
  const state = await createIndicatorFixture(t, { adapterId: "antigravity", version: "1.3.2" });
  await state.service.publishDeliveryBinding(state.binding);
  const { stdout } = await exec(process.execPath,
    ["--permission", "--allow-fs-read=*", path.join(f.installed, "bin", "acc-indicator.mjs"),
      "--adapter", "antigravity", "--native-session", "native-session"],
    { env: { ...f.env, ACC_DATA_HOME: state.dataHome }, cwd: f.project });
  assert.equal(stripVTControlCharacters(stdout), "ACC ●\n");
  assert.deepEqual(stdout.split(/\x1b\[[0-9;]*m/g), ["ACC ", "●", "\n"]);
  assert.match(stdout, /\x1b\[22;1;38;2;44;122;57m●\x1b\[22;39m/);
});

for (const [adapterId, version, key, suffix] of [
  ["kimi", "2.1.1", "sessionId", "turn"], ["grok", "1.0.46", "session_id", "inbox"],
]) test(`the installed ${adapterId} command reads its exact native payload and keeps footer information`, async t => {
  const f = await createPackedAcc(t);
  const state = await createIndicatorFixture(t, { adapterId, version });
  await f.setClientVersions({ [adapterId]: version });
  await f.acc(["install", "--adapter", adapterId, "--indicator", "on", "--delivery", "off"]);
  const file = path.join(f.clientHome, adapterId === "kimi" ? ".kimi-code" : ".grok",
    adapterId === "kimi" ? "tui.toml" : "config.toml");
  assert.match(await readFile(file, "utf8"), /acc-indicator/);
  const payload = { [key]: "native-session", cwd: "/tmp/project",
    model: adapterId === "kimi" ? "K3" : { display_name: "Grok" }, context_window: { used_percentage: 12 } };
  const child = exec(process.execPath, ["--permission", "--allow-fs-read=*",
    path.join(f.dataHome, "acc", "runtime", "bin", "acc-indicator.mjs"), "--adapter", adapterId, "--json"],
  { env: { ...f.env, ACC_DATA_HOME: state.dataHome }, cwd: f.project });
  child.child.stdin.end(JSON.stringify(payload));
  const report = JSON.parse((await child).stdout);
  assert.equal(report.health, "ready");
  assert.equal(report.reception, suffix);
  // Classification uses the normal diagnostic budget during the parallel suite.
  // The native Kimi capture separately measures its strict 300 ms UI deadline.
  const packed = await import(pathToFileURL(path.join(f.installed, "node_modules",
    "@agents-can-communicate", `adapter-${adapterId}`, "src", "indicator.mjs")).href);
  const extension = packed[`${adapterId}Indicator`];
  const stdout = extension.composeText({payload, indicator: extension.renderText(report)});
  assert.match(stripVTControlCharacters(stdout), new RegExp(`^ACC ● · ${suffix} │`));
  assert.match(stdout, /\x1b\[22;1;38;2;44;122;57m●/);
  assert.match(stdout, /project/);
  await f.acc(["install", "--adapter", adapterId, "--indicator", "off", "--delivery", "off"]);
  await assert.rejects(readFile(file), { code: "ENOENT" });
});
