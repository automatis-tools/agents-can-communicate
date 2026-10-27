// Reintroducing npm's Windows shell boundary exposes filenames to cmd parsing.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runPushCommand } from "../../scripts/push-targets.mjs";

const cwd = path.resolve(import.meta.dirname, "../..");

test("Windows npm preserves selection filenames as shell-free argv", async () => {
  const cli = await realpath(path.join(path.dirname(process.execPath),
    process.platform === "win32" ? "node_modules/npm/bin/npm-cli.js" : "npm"));
  const args = ["test", "--", "--selection-plan",
    'C:\\Users\\Jane Doe\\AppData\\Local\\Temp\\plan & (owned) %PATH% !literal! ^data\\selection.json', "--if-needed"];
  let call;
  await runPushCommand("npm", args, { cwd, quiet: true, platform: "win32", env: { ACC_NPM_ARGUMENT_CONTROL: "preserved" },
    spawnCommand: (file, passed, options) => {
      call = { file, args: passed, options };
      const child = Object.assign(new EventEmitter(), { pid: 12345,
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      queueMicrotask(() => child.emit("close", 0));
      return child;
    } });
  assert.equal(call.file, process.execPath, "npm must execute its JavaScript CLI through Node");
  assert.deepEqual(call.args, [cli, ...args], "selection filename must remain one unchanged argument");
  assert.equal(call.options.shell, false, "shell parsing must never interpret npm arguments");
  assert.equal(call.options.cwd, cwd);
  assert.equal(call.options.env.ACC_NPM_ARGUMENT_CONTROL, "preserved");
});

for (const phase of ["before", "during"]) {
  test(`npm cancellation ${phase} CLI resolution never launches a child`, async () => {
    const controller = new AbortController();
    if (phase === "before") controller.abort();
    let launched = false;
    const running = runPushCommand("npm", ["test"], { cwd, signal: controller.signal,
      spawnCommand: () => { launched = true; throw Error("unexpected spawn"); } });
    controller.abort();
    await assert.rejects(running, /push validation interrupted/);
    assert.equal(launched, false);
  });
}

test("npm spawn errors retain the command error", async () => {
  const denied = Object.assign(Error("spawn denied"), { code: "EACCES" });
  await assert.rejects(runPushCommand("npm", ["test"], { cwd,
    spawnCommand: () => { throw denied; } }), error => error === denied);
});
