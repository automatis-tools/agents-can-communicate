// Windows runs a Node shim where POSIX runs `sh`: no Windows client can be
// relied on to have a POSIX shell. The shim is plain JavaScript, so it is
// written for win32 and run by this node on any host.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { bakeSkillCommand, writeCliShim, writeHookShim } from "../src/hook-shim.mjs";

const run = promisify(execFile);

async function place(t, name = "acc shims") {
  // A space in the path: every Windows profile under "C:\Users\First Last".
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-node-shim-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  const seen = path.join(root, "seen.json");
  const target = path.join(root, "runner's copy.mjs");
  await writeFile(target, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2),
  dataHome: process.env.ACC_DATA_HOME ?? null, stdin: await new Promise(resolve => {
    let text = ""; process.stdin.on("data", chunk => { text += chunk; });
    process.stdin.on("end", () => resolve(text)); }) }));
process.stdout.write("runner-output");
`);
  return { root, dir, seen, target };
}

const fire = (shim, args, input = "") => new Promise(resolve => {
  const child = execFile(process.execPath, [shim, ...args], { env: {} },
    (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  child.stdin.end(input);
});

test("windows: the hook shim runs the pinned runner with the adapter, the event and the payload", async t => {
  const { dir, seen, target } = await place(t);
  const shim = await writeHookShim({ dir, adapterId: "codex", runner: target, node: process.execPath,
    dataHome: "C:\\Users\\First Last\\AppData\\Local", platform: "win32" });
  assert.equal(path.basename(shim), "acc-hook.mjs");
  const result = await fire(shim, ["sessionStart"], "{\"hook_event_name\":\"SessionStart\"}");
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "runner-output", "the runner's output is the hook's output");
  const observed = JSON.parse(await readFile(seen, "utf8"));
  assert.deepEqual(observed.argv, ["codex", "sessionStart"]);
  assert.equal(observed.dataHome, "C:\\Users\\First Last\\AppData\\Local");
  assert.equal(observed.stdin, "{\"hook_event_name\":\"SessionStart\"}");
});

test("windows: with the runner gone the hook says so and the turn goes on", async t => {
  const { dir, root, target } = await place(t);
  const shim = await writeHookShim({ dir, adapterId: "claude_code", runner: target,
    node: path.join(root, "node.exe"), platform: "win32" });
  await rm(target);
  const result = await fire(shim, ["beforeTurn"]);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /the hook runner installed here is gone/);
  assert.match(result.stderr, /acc install/);
});

test("windows: the CLI shim passes the agent's arguments and fails loudly when the CLI is gone", async t => {
  const { dir, seen, target, root } = await place(t);
  const shim = await writeCliShim({ dir, cli: target, node: process.execPath, platform: "win32" });
  assert.equal(path.basename(shim), "acc-cli.mjs");
  await fire(shim, ["status", "--json", "it's"]);
  assert.deepEqual(JSON.parse(await readFile(seen, "utf8")).argv, ["status", "--json", "it's"]);
  const gone = await writeCliShim({ dir: path.join(root, "gone"), cli: path.join(root, "missing.mjs"),
    node: path.join(root, "node.exe"), platform: "win32" });
  const result = await fire(gone, ["status"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /the CLI installed here is gone/);
});

test("windows: the skill names node and the shim, with forward slashes and quotes", async t => {
  const { root } = await place(t);
  const skill = path.join(root, "skills", "acc", "SKILL.md");
  await mkdir(path.dirname(skill), { recursive: true });
  await writeFile(skill, "Run {{ACC}} status.\n");
  await bakeSkillCommand({ root, cliShim: "C:\\Users\\First Last\\.claude\\acc\\acc-cli.mjs",
    platform: "win32" });
  assert.equal(await readFile(skill, "utf8"),
    "Run node \"C:/Users/First Last/.claude/acc/acc-cli.mjs\" status.\n");
});
