// Real forwarding/probe failures plus the existing raw runner's owned teardown.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { pushDocsFixture } from "../helpers/push-docs-fixture.mjs";
import { fixture } from "../helpers/push-fixture.mjs";
import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runPushCommand } from "../../scripts/push-targets.mjs";
import { publicNpmFailure, windowsNpmFixture } from "../helpers/windows-npm-fixture.mjs";

const run = (f, options = {}) => runPushCommand("npm", ["test", "--", "owned & literal"], {
  cwd: f.cwd, env: f.env, platform: "win32", quiet: true, spawnCommand: f.launch, ...options });
const fakeChild = () => Object.assign(new EventEmitter(), { pid: 12345, unref() {},
  stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });

test("PATH order selects another external npm bin string and preserves Node pair", async t => {
  const f = await windowsNpmFixture(t);
  f.env.Path = [f.bins[1], f.bins[0], path.dirname(process.execPath)].join(path.delimiter);
  await run(f);
  const records = await f.records();
  assert.deepEqual(records.map(record => record.label), ["second", "second"]);
  assert.equal(f.calls.at(-1).file, f.node);
  assert.equal(f.calls.at(-1).args[0], f.clis[1]);
  assert.equal(f.calls.at(-1).options.env.PATH, undefined);
  assert.equal(f.calls.at(-1).options.env.Path, f.env.Path);
  const output = f.calls[0].options.env.ACC_PUSH_NPM_PROBE;
  assert.equal(existsSync(path.dirname(output)), false, "successful discovery cleans owned directory");
});

for (const [label, setup] of [
  ["missing", async f => writeFile(path.join(path.dirname(f.clis[0]), "package.json"), '{"name":"not-npm","bin":"entry.mjs"}')],
  ["bin mismatch", async f => writeFile(path.join(path.dirname(f.clis[0]), "package.json"), '{"name":"npm","bin":"other-cli.mjs"}')],
  ["absent metadata", async f => rm(path.join(path.dirname(f.clis[0]), "package.json"))],
  ["duplicate", async f => append(f, `import {readFileSync as read,appendFileSync as append} from 'node:fs'; append(process.env.ACC_PUSH_NPM_PROBE, read(process.env.ACC_PUSH_NPM_PROBE));`)],
  ["unsupported schema", async f => append(f, `import {writeFileSync as write} from 'node:fs'; write(process.env.ACC_PUSH_NPM_PROBE, JSON.stringify({schema:2,node:process.execPath,cli:process.argv[1]})+'\\n');`)],
  ["relative target", async f => append(f, `import {writeFileSync as write} from 'node:fs'; write(process.env.ACC_PUSH_NPM_PROBE, JSON.stringify({schema:1,node:process.execPath,cli:'entry.mjs'})+'\\n');`)],
  ["malformed", async f => append(f, `import {writeFileSync as write} from 'node:fs'; write(process.env.ACC_PUSH_NPM_PROBE, '{broken');`)],
  ["non-file", async f => append(f, `import {writeFileSync as write} from 'node:fs'; write(process.env.ACC_PUSH_NPM_PROBE, JSON.stringify({schema:1,node:process.execPath,cli:process.cwd()})+'\\n');`)],
  ["absent target", async f => append(f, `import {writeFileSync as write} from 'node:fs'; write(process.env.ACC_PUSH_NPM_PROBE, JSON.stringify({schema:1,node:process.execPath,cli:process.cwd()+'/absent'})+'\\n');`)],
  ["unsupported preload", async f => {
    // A forwarding wrapper that suppresses discovery cannot silently fall back.
    await writeFile(path.join(f.bins[0], "npm"), '#!/bin/sh\nunset NODE_OPTIONS\nexec "$ACC_FIXTURE_NODE" "$ACC_FIXTURE_CLI_first" "$@"\n');
    await writeFile(path.join(f.bins[0], "npm.cmd"), '@echo off\r\nset NODE_OPTIONS=\r\n"%ACC_FIXTURE_NODE%" "%ACC_FIXTURE_CLI_first%" %*\r\n');
  }],
  ["nonzero query", async f => append(f, "process.exitCode = 23;")],
]) {
  test(`${label} discovery rejects without launching validation and cleans ordinary resources`, async t => {
    const f = await windowsNpmFixture(t); await setup(f);
    await assert.rejects(run(f), /cannot resolve the Windows npm CLI/);
    assert.equal(f.calls.length, 1);
    assert.equal(existsSync(path.dirname(f.calls[0].options.env.ACC_PUSH_NPM_PROBE)), false);
  });
}
async function append(f, source) { await writeFile(f.clis[0], `${await readFile(f.clis[0], "utf8")}\n${source}`); }

for (const mode of ["spawn throw", "spawn error", "spawn abort", "abort", "overflow", "result overflow", "combined overflow", "timeout", "killer failure", "killer timeout", "between phases"]) {
  test(`discovery ${mode} settles boundedly with no validation and correct resource retention`, async t => {
    const f = await windowsNpmFixture(t);
    const controller = new AbortController();
    let output; let child; let killer; let queryStarted;
    const started = new Promise(resolve => { queryStarted = resolve; });
    const calls = [];
    const signal = controller.signal;
    if (mode === "between phases") {
      // Abort when discovery releases its final listener, after successful result
      // validation. This is the actual inter-phase ownership boundary.
      const remove = signal.removeEventListener.bind(signal);
      signal.removeEventListener = (...args) => {
        remove(...args);
        controller.abort();
      };
    }
    const spawnCommand = (file, args, options) => {
      calls.push({ file, args, options });
      if (file === "taskkill") {
        killer = fakeChild();
        assert.deepEqual(args, ["/pid", "12345", "/t", "/f"]);
        if (mode !== "killer timeout") queueMicrotask(() => killer.emit("close", mode === "killer failure" ? 1 : 0));
        return killer;
      }
      assert.equal(args[0], "/d", "no final validation may start after discovery failure");
      output = options.env.ACC_PUSH_NPM_PROBE;
      t.after(() => rm(path.dirname(output), { recursive: true, force: true }));
      if (mode === "spawn throw") throw Error("private spawn error");
      child = fakeChild();
      if (mode === "spawn abort") controller.abort();
      queueMicrotask(async () => {
        if (mode === "spawn error") child.emit("error", Error("private spawn error"));
        else if (mode === "overflow") child.stdout.write(Buffer.alloc(65537));
        else if (mode === "result overflow") { writeFileSync(output, Buffer.alloc(65537)); child.stdout.write("x"); }
        else if (mode === "combined overflow") { writeFileSync(output, Buffer.alloc(33000)); child.stderr.write(Buffer.alloc(33000)); }
        else if (mode === "between phases") {
          writeFileSync(output, JSON.stringify({ schema: 1, node: f.node, cli: f.clis[0] }) + "\n");
          child.emit("close", 0);
        } else if (mode !== "timeout") controller.abort();
        queryStarted();
      });
      return child;
    };
    if (["timeout", "killer timeout"].includes(mode)) t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const running = run(f, { signal, spawnCommand });
    const forced = ["overflow", "result overflow", "combined overflow", "timeout", "killer failure", "killer timeout"].includes(mode);
    const rejection = assert.rejects(running, error => {
      if (forced) assert.equal(error.code, "PUSH_TERMINATION_UNCONFIRMED");
      assert.doesNotMatch(error.message, /private spawn error|acc-npm-shim/);
      return true;
    });
    if (mode !== "spawn throw") await started;
    if (mode === "timeout") t.mock.timers.tick(10001);
    if (mode === "killer timeout") t.mock.timers.tick(2001);
    await rejection;
    assert.ok(calls.length <= 2);
    const retain = forced || controller.signal.aborted;
    assert.equal(existsSync(path.dirname(output)), retain);
    if (retain && process.platform !== "win32") {
      assert.equal((await stat(path.dirname(output))).mode & 0o777, 0o700);
      assert.equal((await stat(output)).mode & 0o777, 0o600);
    }
  });
}


test("discovery overflow retains probe, selection plan and isolated checkout together", async t => {
  const f = await fixture(t);
  const resultFile = path.join(f.base, "retention.json");
  const targets = pathToFileURL(path.resolve(import.meta.dirname, "../../scripts/push-targets.mjs")).href;
  const selection = pathToFileURL(path.resolve(import.meta.dirname, "../../scripts/push-selection.mjs")).href;
  const script = `import {withPushCheckout,runPushCommand} from ${JSON.stringify(targets)};
    import {withSelectionPlan} from ${JSON.stringify(selection)};
    import {EventEmitter} from 'node:events'; import {PassThrough} from 'node:stream';
    import {writeFileSync} from 'node:fs';
    const owned = {};
    try { await withPushCheckout(process.cwd(), {commit:${JSON.stringify(await f.oid())},checkout:'isolated'}, async (cwd,signal) => {
      owned.checkout = cwd;
      await withSelectionPlan({},signal,async plan => {
        owned.plan = plan;
        await runPushCommand('npm',['test','--','--selection-plan',plan], {cwd,signal,platform:'win32',quiet:true,
          env:{ComSpec:process.env.ComSpec ?? process.env.COMSPEC ?? '/bin/sh'}, spawnCommand:(file,args,options) => {
            const child=Object.assign(new EventEmitter(),{pid:12345,unref(){},stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});
            if(file==='taskkill') queueMicrotask(()=>child.emit('close',0));
            else {owned.probe=options.env.ACC_PUSH_NPM_PROBE;queueMicrotask(()=>child.stdout.write(Buffer.alloc(65537)));}
            return child;
          }});
      });
    }); } catch(error) {owned.code=error.code;}
    writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(owned));`;
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
    cwd: f.root, env: { ...f.env, npm_config_cache: path.join(f.base, "npm-cache") }, timeout: 30000,
  });
  const owned = JSON.parse(await readFile(resultFile, "utf8"));
  try {
    assert.equal(owned.code, "PUSH_TERMINATION_UNCONFIRMED");
    for (const file of [owned.checkout, owned.plan, owned.probe]) assert.ok(file && existsSync(file));
    assert.equal((await f.git(["worktree", "list", "--porcelain"])).stdout.match(/^worktree /gm).length, 2);
  } finally {
    if (owned.checkout) {
      await f.git(["worktree", "remove", "--force", owned.checkout]);
      await rm(path.dirname(owned.checkout), { recursive: true, force: true });
    }
    for (const file of [owned.plan, owned.probe]) if (file) await rm(path.dirname(file), { recursive: true, force: true });
  }
});


test("probe and resolver bytes participate in the independent selection contract", async t => {
  const f = await pushDocsFixture(t);
  assert.equal(await f.supportsSelection(f.root), true);
  for (const file of ["scripts/push-npm.mjs", "scripts/push-npm-probe.mjs"]) {
    const original = await f.read(file);
    await f.write(file, `${original}\n// historical discovery\n`);
    assert.equal(await f.supportsSelection(f.root), false, file);
    await f.write(file, original);
  }
});

test("discovery error after abort still waits for owned taskkill confirmation", async t => {
  const f = await windowsNpmFixture(t);
  const controller = new AbortController();
  const child = fakeChild(); const killer = fakeChild();
  let output; let started;
  const ready = new Promise(resolve => { started = resolve; });
  const running = run(f, { signal: controller.signal, spawnCommand: (file, args, options) => {
    if (file === "taskkill") return killer;
    output = options.env.ACC_PUSH_NPM_PROBE;
    queueMicrotask(started);
    return child;
  }});
  let settled = false;
  const outcome = running.then(() => { settled = true; return null; }, error => { settled = true; return error; });
  await ready;
  t.after(() => rm(path.dirname(output), { recursive: true, force: true }));
  controller.abort();
  child.emit("error", Error("private late error"));
  await new Promise(resolve => setImmediate(resolve));
  const premature = settled;
  killer.emit("close", 1);
  const error = await outcome;
  assert.equal(premature, false, "discovery settled before taskkill confirmed its outcome");
  assert.equal(error.code, "PUSH_TERMINATION_UNCONFIRMED");
  assert.equal(existsSync(output), true);
});


test("the declared npm bin and symlink argv identify one canonical CLI", async t => {
  const f = await windowsNpmFixture(t);
  const entry = f.clis[0];
  const canonical = path.join(path.dirname(entry), "canonical.mjs");
  await rename(entry, canonical);
  try { await symlink(canonical, entry, "file"); }
  catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) { t.skip("host disallows file symlinks"); return; }
    throw error;
  }
  f.clis[0] = await realpath(canonical);
  await run(f);
  assert.equal(f.calls.at(-1).args[0], f.clis[0]);
  assert.equal((await f.records()).length, 2);
});


for (const mode of ["ordinary", "forced"]) {
  test(`public pre-push reports ${mode} npm discovery failure`, async t => {
    const f = await fixture(t);
    const result = await publicNpmFailure(t, f, mode);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stderr, mode === "ordinary"
      ? /pre-push: target cannot resolve the Windows npm CLI from the selected npm command/
      : /pre-push: target npm discovery output limit exceeded; owned discovery resources retained for recovery/);
    assert.doesNotMatch(result.stderr, /push repository facts unavailable/);
    assert.equal(existsSync(result.output), mode === "forced");
    t.diagnostic(result.stderr.trim());
  });
}


// Object spread can overwrite an inherited key without moving its position.
// A separate child controls the inherited spelling without changing this worker.
test("environment layers preserve Windows override order and POSIX case", async t => {
  const target = pathToFileURL(path.resolve(import.meta.dirname, "../../scripts/push-targets.mjs")).href;
  const cases = [
    ["win32", "Path", { PATH: "first", Path: "last" }, { Path: "last" }],
    ["win32", "PATH", { Path: "first", PATH: "last" }, { PATH: "last" }],
    ["win32", "PATH", { Path: "explicit & (value) %keep% !keep! ^value" }, { Path: "explicit & (value) %keep% !keep! ^value" }],
    ["win32", "Path", { PATH: "explicit" }, { PATH: "explicit" }],
    ["darwin", "Path", { PATH: "first", Path: "last" }, { Path: "last", PATH: "first" }],
    ["darwin", "PATH", { Path: "first", PATH: "last" }, { PATH: "last", Path: "first" }],
  ];
  for (const [platform, inherited, overrides, expected] of cases) {
    await t.test(`${platform} inherited ${inherited}, overrides ${Object.keys(overrides).join(" then ")}`, async () => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
      env[inherited] = "inherited";
      const script = `import {runPushCommand} from ${JSON.stringify(target)};
        import {EventEmitter} from 'node:events'; import {PassThrough} from 'node:stream';
        await runPushCommand(process.execPath,[],{cwd:process.cwd(),quiet:true,
          platform:${JSON.stringify(platform)},env:${JSON.stringify(overrides)},spawnCommand:(file,args,options)=>{
            console.log(JSON.stringify(Object.fromEntries(Object.entries(options.env).filter(([key])=>key.toUpperCase()==='PATH'))));
            const child=Object.assign(new EventEmitter(),{pid:12345,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});
            queueMicrotask(()=>child.emit('close',0)); return child;
          }});`;
      const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { env });
      assert.deepEqual(JSON.parse(result.stdout), expected);
    });
  }
});
