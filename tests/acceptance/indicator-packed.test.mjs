import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createPackedAcc } from "../helpers/packed-acc.mjs";

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
    ui: { log: async line => logs.push(line), invalidate: () => {} } };
  await handlers.get("session.start")($, {}, async e => e);
  now += 6000;
  await tick();
  const rendered = await handlers.get("ui.render")($, { props: { modes: ["existing-mode"] } }, async e => e);
  assert.deepEqual(rendered.props.modes, ["existing-mode", "ACC !"]);
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
