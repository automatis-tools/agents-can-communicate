// Reintroducing npm's Windows shell boundary exposes filenames to cmd parsing.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runPushCommand } from "../../scripts/push-targets.mjs";

const cwd = path.resolve(import.meta.dirname, "../..");

test("Windows npm preserves selection filenames as shell-free argv", async t => {
  // A native Windows Node installation carries npm beside node.exe. On other
  // hosts, give the Windows command seam that installed-package layout via PATH.
  const installed = await mkdtemp(path.join(tmpdir(), "acc-npm-arguments-"));
  t.after(() => rm(installed, { recursive: true, force: true }));
  const prefix = path.join(installed, "npm path & (owned)");
  const packageRoot = path.join(prefix, "node_modules/npm");
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), '{"name":"npm","version":"1.0.0"}');
  await writeFile(path.join(packageRoot, "bin/npm-cli.js"), "// controlled npm entry\n");
  const cli = await realpath(process.platform === "win32"
    ? path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")
    : path.join(packageRoot, "bin/npm-cli.js"));
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === "PATH") ?? "PATH";
  const args = ["test", "--", "--selection-plan",
    'C:\\Users\\Jane Doe\\AppData\\Local\\Temp\\plan & (owned) %PATH% !literal! ^data\\selection.json', "--if-needed"];
  let call;
  await runPushCommand("npm", args, { cwd, quiet: true, platform: "win32", env: { [pathKey]: prefix, ACC_NPM_ARGUMENT_CONTROL: "preserved" },
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

test("already cancelled npm commands never launch a child", async () => {
  const controller = new AbortController();
  controller.abort();
  let launched = false;
  await assert.rejects(runPushCommand("npm", ["test"], { cwd, signal: controller.signal,
    spawnCommand: () => { launched = true; throw Error("unexpected spawn"); } }), /push validation interrupted/);
  assert.equal(launched, false);
});

test("npm spawn errors retain the command error", async () => {
  const denied = Object.assign(Error("spawn denied"), { code: "EACCES" });
  await assert.rejects(runPushCommand("npm", ["test"], { cwd,
    spawnCommand: () => { throw denied; } }), error => error === denied);
});
