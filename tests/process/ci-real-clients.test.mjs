// These subprocess fixtures test CI orchestration, never vendor compatibility.
// Keeping their shared fixed-command fixture and failure controls together avoids
// duplicating the process/phase contract across files, including native Windows.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { npmCli } from "../../packages/cli/src/managed-runtime/download.mjs";

const repo = path.resolve(import.meta.dirname, "../..");
const driver = path.join(repo, "scripts/ci-real-clients.mjs");
const run = promisify(execFile);
const identity = { CI: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/9/merge",
  GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2", GITHUB_SHA: "a".repeat(40),
  GITHUB_REPOSITORY: "example/repo", GITHUB_WORKFLOW: "CI", GITHUB_JOB: "real-clients" };

async function fixture(t, changes = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-clients spaces & % ! `$()-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidenceDir = path.join(root, "evidence");
  const calls = path.join(root, "calls.jsonl");
  const program = path.join(root, "fake-cli.mjs");
  await writeFile(program, `import { appendFileSync } from 'node:fs';
const [role, ...args] = process.argv.slice(2);
appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify({role,args,cwd:process.cwd(),
  data:process.env.GITHUB_REF,real:process.env.ACC_REAL_CLIENTS,git:process.env.GIT_DIR})+'\\n');
const c=JSON.parse(process.env.FIXTURE_CONFIG);
const value=c[role==='npm'&&args[0]==='--version'?'npmVersion':role]??{};
if(role==='npm' && args[0]==='--version') {console.log(value.stdout??'11.4.2');process.exitCode=value.code??0;}
else if(role==='git') {console.log(value.stdout??'b'.repeat(40));process.exitCode=value.code??0;}
else { process.stdout.write(value.stdout ?? ({claude:'2.1.312 (Claude Code)\\n',
 codex:'codex-cli 0.165.0\\n',npm:'installed clients\\n',python:'terminal installed\\n'}[role]??''));
process.stderr.write(value.stderr??'');process.exitCode=value.code??0; }
`);
  const files = {};
  for (const name of ["first", "second"]) {
    files[name] = path.join(root, `${name}.test.mjs`);
    await writeFile(files[name], "import test from 'node:test'; test('one',()=>{}); test('two',()=>{});\n");
  }
  const env = { ...process.env, ...identity, RUNNER_TEMP: root, FIXTURE_CALLS: calls,
    FIXTURE_CONFIG: "{}", ...changes };
  delete env.NODE_TEST_CONTEXT;
  const dependencies = { npmCli: async () => program, spawn(executable, args, options) {
    const isTest = args[0] === "--test";
    if (isTest) {
      assert.equal(executable, process.execPath);
      assert.deepEqual(args.slice(0, 2), ["--test", "--test-reporter=tap"]);
      assert.deepEqual(args.slice(2), [args[2].includes("real-clients-stub")
        ? "tests/acceptance/real-clients-stub.test.mjs" : "tests/acceptance/real-claude-live-stub.test.mjs"]);
      assert.equal(options.env.ACC_REAL_CLIENTS, "1");
      assert.equal(options.env.GIT_DIR, "");
      assert.equal(options.env.GIT_WORK_TREE, "");
      const target = args[2].includes("real-clients-stub") ? "first" : "second";
      return spawn(executable, [...args.slice(0, 2), ...(env.FIXTURE_ZERO === target ? ["--test-name-pattern=absent-case"] : []),
        files[target]], options);
    }
    let role = executable;
    let forwarded = args;
    if (executable === process.execPath) {
      assert.equal(args[0], program);
      role = "npm"; forwarded = args.slice(1);
    } else if (executable === "pwsh") {
      assert.deepEqual(args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
      const match = /^\$ErrorActionPreference = 'Stop'; (claude|codex) --version; exit \$LASTEXITCODE$/.exec(args[4]);
      assert.ok(match, "only fixed trusted PowerShell commands");
      role = match[1]; forwarded = ["--version"];
    }
    assert.equal(options.shell, false);
    return spawn(process.execPath, [program, role, ...forwarded], options);
  } };
  const invoke = async (context = {}, deps = {}) => {
    const { runRealClients } = await import(driver);
    const code = await runRealClients({ cwd: root, evidenceDir, env, ...context }, { ...dependencies, ...deps });
    const report = JSON.parse(await readFile(path.join(evidenceDir, "compatibility.json"), "utf8"));
    return { code, report, phases: Object.fromEntries(report.phases.map(phase => [phase.id, phase])) };
  };
  return { root, env, files, invoke, program, calls, dependencies,
    config(value) { env.FIXTURE_CONFIG = JSON.stringify(value); } };
}

test("pinned PR runs exact installs, both behavioral commands and complete evidence", async t => {
  const f = await fixture(t);
  const { code, report: r, phases: p } = await f.invoke();
  assert.equal(code, 0);
  assert.equal(r.status, "passed");
  assert.equal(r.policy, "pinned-pr");
  assert.deepEqual(r.requestedClients, { claude: "2.1.312", codex: "0.165.0" });
  assert.deepEqual(p.install.args, [f.program, "install", "--global", "@anthropic-ai/claude-code@2.1.312", "@openai/codex@0.165.0"]);
  assert.equal(p.install.executable, process.execPath);
  assert.equal(r.observedClients.claude.version, "2.1.312");
  assert.equal(r.observedClients.codex.version, "0.165.0");
  assert.equal(r.context.checkoutSha, "b".repeat(40));
  assert.equal(r.context.githubSha, "a".repeat(40));
  assert.equal(r.context.npmVersion, "11.4.2");
  assert.equal(r.context.nodeVersion, process.version);
  assert.equal(r.context.nodeExecutable, process.execPath);
  assert.equal(r.context.platform, process.platform);
  assert.equal(r.context.runAttempt, "2");
  assert.equal(r.context.pullRequestHeadSha, null);
  assert.equal(r.conditions.externalModelProvider, false);
  assert.equal(r.conditions.certification, false);
  assert.equal(r.conditions.modelEndpoint, "loopback-stub");
  assert.equal(r.conditions.privateClientHomes, true);
  assert.equal(r.conditions.packedAcc, true);
  for (const id of ["install", "claude-version", "codex-version", "hooks", "interactive"]) {
    assert.equal(p[id].status, "passed", id);
    assert.equal(p[id].exitCode, 0);
    assert.ok(p[id].durationMs >= 0);
    assert.ok(p[id].startedAt && p[id].finishedAt);
    await access(path.join(f.root, "evidence", p[id].stdoutFile));
    await access(path.join(f.root, "evidence", p[id].stderrFile));
  }
  assert.equal(p.hooks.tests.tests, 2);
  assert.equal(p.interactive.tests.pass, 2);
  assert.equal(p.pywinpty.status, process.platform === "win32" ? "passed" : "not-applicable");
});

test("main and manual latest retain moving installs while other events cannot install", async t => {
  for (const [event, ref, code] of [["push", "refs/heads/main", 0], ["workflow_dispatch", "refs/heads/main", 0],
    ["push", "refs/heads/other", 1], ["schedule", "refs/heads/main", 1]]) {
    const f = await fixture(t, { GITHUB_EVENT_NAME: event, GITHUB_REF: ref,
      GITHUB_WORKFLOW: event === "workflow_dispatch" ? "Client compatibility (latest)" : "CI" });
    f.config({ claude: { stdout: "9.2.1 (Claude Code)\n" }, codex: { stdout: "codex-cli 8.4.2\n" } });
    const { report: r, phases: p, code: actual } = await f.invoke();
    assert.equal(actual, code);
    if (code === 0) {
      assert.equal(r.policy, "latest");
      assert.deepEqual(p.install.args.slice(1), ["install", "--global", "@anthropic-ai/claude-code", "@openai/codex"]);
    } else assert.equal(p.install.status, "not-run");
  }
});

test("public CLI refuses missing CI identity and extra arguments before acquisition", async t => {
  const f = await fixture(t);
  for (const args of [[], ["--version"]]) {
    const result = await run(process.execPath, [driver, ...args], {
      env: { PATH: process.env.PATH }, cwd: f.root }).then(() => null, error => error);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /CI|arguments/);
  }
  const { code, phases } = await f.invoke({ env: { ...f.env, GITHUB_RUN_ID: "" } });
  assert.equal(code, 1);
  assert.equal(phases.install.status, "not-run");
});

test("install resolution, launch and nonzero failures retain truthful unavailable observations", async t => {
  for (const failure of ["resolve", "launch", "exit"]) {
    const f = await fixture(t);
    f.config({ npm: { code: 37, stderr: "acquisition diagnostic\n" } });
    const deps = failure === "resolve" ? { npmCli: async () => { throw new Error("no npm"); } }
      : failure === "launch" ? { spawn(exe, args, options) {
        return args.includes("install") ? spawn(path.join(f.root, "missing"), [], options)
          : f.dependencies.spawn(exe, args, options);
      } } : {};
    const { code, report: r, phases: p } = await f.invoke({}, deps);
    assert.equal(code, 1);
    assert.equal(r.status, "failed");
    assert.equal(p[ failure === "resolve" ? "npm-resolution" : "install" ].status, "failed");
    assert.equal(p.hooks.status, "not-run");
    assert.equal(r.observedClients.codex.version, null);
    assert.equal(p["claude-version"].status, "not-run");
    if (failure === "exit") {
      assert.equal(p.install.exitCode, 37);
      assert.equal(await readFile(path.join(f.root, "evidence", p.install.stderrFile), "utf8"), "acquisition diagnostic\n");
    }
    if (failure === "launch") assert.equal(p.install.spawnError.code, "ENOENT");
  }
});

test("wrong, absent, diagnostic-only and nonzero client versions block behavior and retain both probes", async t => {
  for (const value of [{ stdout: "2.1.311 (Claude Code)\n" }, { stdout: "" },
    { stdout: "warning mentions 2.1.312\n" }, { stdout: "2.1.312 (Claude Code)\n", code: 7 }]) {
    const f = await fixture(t); f.config({ claude: value });
    const { code, report: r, phases: p } = await f.invoke();
    assert.equal(code, 1);
    assert.equal(p["claude-version"].status, "failed");
    assert.equal(p["codex-version"].status, "passed");
    assert.equal(r.failure.phase, "claude-version");
    assert.equal(p.hooks.status, "not-run");
    assert.equal(await readFile(path.join(f.root, "evidence", p["claude-version"].stdoutFile), "utf8"), value.stdout);
  }
  const f = await fixture(t); f.config({ codex: { stdout: "", code: 1, stderr: "Missing optional dependency @openai/codex-win32-x64.\n" } });
  const { report: r, phases: p } = await f.invoke();
  assert.equal(r.observedClients.codex.version, null);
  assert.equal(p["claude-version"].status, "passed");
  assert.match(await readFile(path.join(f.root, "evidence", p["codex-version"].stderrFile), "utf8"), /Missing optional dependency/);
});

test("actual failed, empty, skipped, todo and cancelled TAP processes cannot pass either behavioral phase", async t => {
  for (const [body, expected] of [["test('bad',()=>{throw Error('behavior fault')})", "fail"],
    ["test('present-case',()=>{})", "tests"], ["test.skip('skipped',()=>{})", "skipped"], ["test.todo('later')", "todo"],
    ["test('cancelled',{timeout:20},()=>new Promise(()=>{}))", "cancelled"]]) {
    for (const target of ["first", "second"]) {
      const f = await fixture(t);
      if (expected === "tests") f.env.FIXTURE_ZERO = target;
      await writeFile(f.files[target], `import test from 'node:test'; ${body};\n`);
      const { code, phases: p } = await f.invoke();
      assert.equal(code, 1, `${expected} ${target}`);
      const phase = p[target === "first" ? "hooks" : "interactive"];
      assert.equal(phase.status, "failed");
      // Node 24 wraps a no-matching-test file as one passing file; its empty
      // plan still must fail this compatibility gate, with raw counters intact.
      assert.equal(phase.tests[expected], 1);
      if (target === "first") assert.equal(p.interactive.status, "not-run");
      else assert.equal(p.hooks.status, "passed");
    }
  }
});

test("missing final TAP summary and Windows terminal failure remain visible", async t => {
  const f = await fixture(t);
  await writeFile(f.files.first, "process.stdout.write('TAP version 13\\nok 1 - misleading\\n');\n");
  const deps = { spawn(exe, args, options) {
    if (args[0] === "--test") return spawn(process.execPath, [f.files.first], options);
    return f.dependencies.spawn(exe, args, options);
  } };
  const missing = await f.invoke({}, deps);
  assert.equal(missing.code, 1);
  assert.equal(missing.phases.hooks.tests, null);
  const w = await fixture(t); w.config({ python: { code: 17, stderr: "no terminal\n" } });
  const { code, phases: p } = await w.invoke({ platform: "win32" });
  assert.equal(code, 1);
  assert.equal(p.hooks.status, "passed");
  assert.deepEqual(p.pywinpty.args, ["-m", "pip", "install", "--quiet", "pywinpty"]);
  assert.equal(p.pywinpty.exitCode, 17);
  assert.equal(p.interactive.status, "not-run");
});

test("hostile metadata and paths reach subprocesses as exact data, never shell code", async t => {
  const f = await fixture(t);
  const marker = path.join(f.root, "EXECUTED");
  const data = `spaces & % ! ' "\n\`touch '${marker}'\` $(touch '${marker}')`;
  f.env.GITHUB_REF = data;
  const { code, report: r } = await f.invoke();
  assert.equal(code, 0);
  assert.equal(r.context.ref, data);
  const calls = (await readFile(f.calls, "utf8")).trim().split("\n").map(JSON.parse);
  for (const call of calls) { assert.equal(call.cwd, f.root); assert.equal(call.data, data); }
  assert.deepEqual(calls.find(call => call.role === "npm" && call.args[0] === "install").args,
    ["install", "--global", "@anthropic-ai/claude-code@2.1.312", "@openai/codex@0.165.0"]);
  await assert.rejects(access(marker), { code: "ENOENT" });
});

test("diagnostic and Codex version failures cannot turn successful acquisition into compatibility proof", async t => {
  for (const config of [{ npmVersion: { code: 8 } }, { git: { stdout: "unknown" } },
    { codex: { stdout: "codex-cli 0.164.0\n" } }]) {
    const f = await fixture(t); f.config(config);
    const { code, report: r, phases: p } = await f.invoke();
    assert.equal(code, 1);
    assert.equal(p.install.status, "passed");
    assert.equal(p.hooks.status, "not-run");
    assert.ok(r.failure);
    if (config.npmVersion) assert.equal(r.context.npmVersion, null);
    if (config.git) assert.equal(r.context.checkoutSha, null);
    if (config.codex) assert.equal(r.observedClients.codex.version, "0.164.0");
  }
});

test("actual Git identity ignores inherited repository redirection", async t => {
  const f = await fixture(t);
  const clean = { ...f.env }; delete clean.GIT_DIR; delete clean.GIT_WORK_TREE;
  await run("git", ["init", "--quiet"], { cwd: f.root, env: clean });
  await run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], { cwd: f.root, env: clean });
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: f.root, env: clean });
  f.env.GIT_DIR = "nonexistent"; f.env.GIT_WORK_TREE = "incorrect";
  const { code, report: r } = await f.invoke({}, { spawn(exe, args, options) {
    return exe === "git" ? spawn(exe, args, options) : f.dependencies.spawn(exe, args, options);
  } });
  assert.equal(code, 0); assert.equal(r.context.checkoutSha, stdout.trim());
});

test("a failing log destination reaps its real child before returning and blocks later phases", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, "evidence", "npm-version.stderr.log"), { recursive: true });
  let child, closed, actualResult;
  const launched = [];
  t.after(async () => {
    if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  const { code, report: r, phases: p } = await f.invoke({}, { spawn(exe, args, options) {
    launched.push(args);
    if (exe !== process.execPath || args[0] !== f.program || args[1] !== "--version") return f.dependencies.spawn(exe, args, options);
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
    closed = new Promise(resolve => child.once("close", (exitCode, signal) => {
      actualResult = { exitCode, signal }; resolve();
    }));
    return child;
  } });
  assert.equal(code, 1);
  assert.ok(actualResult, "the driver must observe child close before returning");
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" }, "owned child must no longer be alive");
  const phase = p["npm-version"];
  assert.deepEqual({ exitCode: phase.exitCode, signal: phase.signal }, actualResult);
  assert.equal(phase.status, "failed");
  assert.equal(phase.spawnError, null);
  assert.ok(["EISDIR", "EPERM", "EACCES"].includes(phase.outputError.code), phase.outputError.message);
  assert.equal(r.status, "failed");
  assert.equal(r.failure.phase, "npm-version");
  assert.equal(p.checkout.status, "not-run");
  assert.equal(p.install.status, "not-run");
  assert.equal(p["claude-version"].status, "not-run");
  assert.equal(p.hooks.status, "not-run");
  assert.equal(launched.length, 1, "only the failing npm version command may launch");
  t.diagnostic(JSON.stringify({ childReaped: true, ...actualResult, outputError: phase.outputError.code,
    reportStatus: r.status, commandsLaunched: launched.length }));
});

test("native Windows resolves fixed version commands in PowerShell and actual npm under Node",
  { skip: process.platform !== "win32" }, async t => {
    const f = await fixture(t);
    const bin = path.join(f.root, "bin"); await mkdir(bin);
    for (const client of ["claude", "codex"]) await writeFile(path.join(bin, `${client}.ps1`),
      `& $env:FIXTURE_NODE $env:FIXTURE_PROGRAM ${client} @args\nexit $LASTEXITCODE\n`);
    f.env.FIXTURE_NODE = process.execPath; f.env.FIXTURE_PROGRAM = f.program;
    const pathKey = Object.keys(f.env).find(key => key.toUpperCase() === "PATH");
    f.env[pathKey] = `${bin}${path.delimiter}${f.env[pathKey]}`;
    const actualNpm = await npmCli(f.env);
    const { code, phases: p } = await f.invoke({}, { npmCli: async () => actualNpm,
      spawn(exe, args, options) {
        if (exe === "pwsh" || (exe === process.execPath && args[0] === actualNpm && args[1] === "--version")) {
          return spawn(exe, args, options);
        }
        return f.dependencies.spawn(exe, args[0] === actualNpm ? [f.program, ...args.slice(1)] : args, options);
      } });
    assert.equal(code, 0);
    assert.equal(p["claude-version"].executable, "pwsh");
    assert.equal(p["codex-version"].exitCode, 0);
    assert.deepEqual(p["npm-version"].args, [actualNpm, "--version"]);
    assert.equal(p["npm-version"].executable, process.execPath);
  });
