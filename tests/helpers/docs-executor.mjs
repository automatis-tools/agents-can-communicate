import { AsyncLocalStorage } from "node:async_hooks";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { promisify } from "node:util";

function output() {
  const chunks = [];
  const stream = new Writable({ write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  stream.isTTY = false;
  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}

function accPath(value) {
  return typeof value === "string" && /^acc(?:-[\w-]+)?\.mjs$/.test(path.basename(value))
    && path.basename(path.dirname(value)) === "bin";
}

// Preserve Node's native environment object: os.homedir() and Windows' case
// insensitive lookups do not follow replacement with an ordinary JS object.
function replaceEnv(values) {
  const next = { ...values };
  for (const name of Object.keys(process.env)) delete process.env[name];
  for (const [name, value] of Object.entries(next)) {
    if (value !== undefined) process.env[name] = value;
  }
}

function target(file, args) {
  if (![file, ...args].some(accPath)) return null;
  const entry = args[0];
  const kind = path.basename(entry ?? "", ".mjs");
  if (file !== process.execPath || !accPath(entry) || !["acc", "acc-hook"].includes(kind)) {
    return { unsupported: true };
  }
  return { kind, packageRoot: path.dirname(path.dirname(entry)) };
}

// This is the documentation vocabulary gate, not an OS-process lifetime test.
// Run the real bootstrap and composition roots; installed-artifact tests retain
// real launchers, process exit and lease reclamation. Here leases belong to the
// real test PID until it exits. Native client and Git probes still run normally.
export async function createDocsExecutor(t, repo) {
  const stats = { cli: 0, hooks: 0, nested: 0, subprocesses: 0 };
  const original = { execFile: childProcess.execFile, spawn: childProcess.spawn };
  const nativeExec = promisify(original.execFile);
  const context = new AsyncLocalStorage();
  const token = {};
  let tail = Promise.resolve();
  let depth = 0;
  let failure = null;
  let runEntry;

  function refuse() {
    stats.subprocesses += 1;
    failure ??= Object.assign(new Error("docs executor refuses an unsupported ACC subprocess"),
      { docsExecutorFailure: true });
    throw failure;
  }

  function serialized(fn) {
    if (context.getStore() === token && depth > 0) return fn();
    const next = tail.then(() => context.run(token, fn));
    tail = next.catch(() => {});
    return next;
  }

  async function invoke(entry, args, options = {}, payload = "") {
    if (entry.unsupported) refuse();
    const saved = { env: process.env, envValues: { ...process.env }, argv: process.argv,
      cwd: process.cwd(), exitCode: process.exitCode };
    const descriptors = Object.fromEntries(["stdin", "stdout", "stderr"]
      .map(name => [name, Object.getOwnPropertyDescriptor(process, name)]));
    const stdout = output();
    const stderr = output();
    const stdin = Readable.from([payload]);
    stdin.isTTY = false;
    depth += 1;
    try {
      replaceEnv(options.env ?? saved.envValues);
      assert.equal(homedir(), process.env.HOME, "native HOME must follow the document sandbox");
      process.argv = [process.execPath, ...args];
      process.exitCode = undefined;
      if (options.cwd !== undefined) process.chdir(options.cwd);
      for (const [name, stream] of Object.entries({ stdin, stdout: stdout.stream, stderr: stderr.stream })) {
        Object.defineProperty(process, name, { configurable: true, value: stream });
      }
      await runEntry(entry);
      // Production deliberately catches some worker/installation errors. A
      // harness refusal must still fail this gate rather than become exit 4.
      if (failure !== null) throw failure;
      const result = { stdout: stdout.text(), stderr: stderr.text() };
      const code = process.exitCode ?? 0;
      if (code !== 0) throw Object.assign(new Error(`ACC exited with ${code}`), result, { code });
      return result;
    } catch (error) {
      if (!Number.isInteger(error.code)) error.docsExecutorFailure = true;
      throw error;
    } finally {
      process.env = saved.env;
      replaceEnv(saved.envValues);
      process.argv = saved.argv;
      process.exitCode = saved.exitCode;
      process.chdir(saved.cwd);
      for (const [name, descriptor] of Object.entries(descriptors)) Object.defineProperty(process, name, descriptor);
      stdin.destroy();
      stdout.stream.destroy();
      stderr.stream.destroy();
      depth -= 1;
    }
  }

  // Patch before importing the CLI: verifyGeneration captures promisify(execFile)
  // at module load. Its installed version check must reach the staged entrypoint,
  // never a fabricated version or an unnoticed child process.
  function execFile(file, args = [], ...rest) {
    if (target(file, args) !== null) refuse();
    return original.execFile(file, args, ...rest);
  }
  Object.defineProperty(execFile, promisify.custom, { value: (file, args = [], options) => {
    const entry = target(file, args);
    if (entry === null) return nativeExec(file, args, options);
    stats.nested += 1;
    return serialized(() => invoke(entry, args, options));
  } });
  childProcess.execFile = execFile;
  childProcess.spawn = (file, args = [], ...rest) => {
    if (target(file, args) !== null) refuse();
    return original.spawn(file, args, ...rest);
  };
  syncBuiltinESMExports();
  const restore = () => {
    childProcess.execFile = original.execFile;
    childProcess.spawn = original.spawn;
    syncBuiltinESMExports();
    context.disable();
  };
  try {
    ({ runEntry } = await import("@agents-can-communicate/cli/managed-entry"));
  } catch (error) {
    restore();
    throw error;
  }
  t.after(async () => { try { await tail; } finally { restore(); } });

  return {
    stats,
    cli(args, options = {}) {
      stats.cli += 1;
      const entryArgs = [path.join(repo, "bin", "acc.mjs"), ...args];
      return serialized(() => invoke(target(process.execPath, entryArgs), entryArgs, options));
    },
    hook(adapter, payload, options = {}) {
      stats.hooks += 1;
      const entryArgs = [path.join(repo, "bin", "acc-hook.mjs"), adapter];
      return serialized(() => invoke(target(process.execPath, entryArgs), entryArgs, options, JSON.stringify(payload)));
    },
  };
}
