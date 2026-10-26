import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { promisify } from "node:util";
import { EXIT } from "@agents-can-communicate/protocol";
import { main } from "../src/main.mjs";
import { admissionFailure, DENIED_GUIDANCE, deniedStateText } from "../src/managed-runtime/admission.mjs";
import { writeControl } from "../src/managed-runtime/state.mjs";
import { removeFixture } from "../../../tests/helpers/fixture-cleanup.mjs";

// #316: a client sandbox that denies writes under ACC's data home made runtime
// admission fail, and every command then answered that an update was
// unfinished - "retry after the update or run acc update" - while the runtime
// was ready and no update was pending. ChatGPT Work Mode refused an fchmod
// there; a Codex chat without ACC's rules file refused the lock's mkdir.

test("an admission the filesystem refuses is a denied state access, named by its operation", () => {
  for (const code of ["EPERM", "EACCES", "EROFS"]) {
    const error = Object.assign(new Error(code), { code, syscall: "fchmod", path: "/data/acc/runtime" });
    assert.deepEqual(admissionFailure(error),
      { reasonCode: "state_access_denied", access: "write", code, syscall: "fchmod", path: "/data/acc/runtime" });
  }
  // The refused operation decides what the text calls it: a read is never a refused write.
  const kind = syscall => admissionFailure(Object.assign(new Error("EACCES"), { code: "EACCES", syscall })).access;
  for (const syscall of ["mkdir", "fchmod", "rename", "unlink", "rmdir", "write", "fsync"]) assert.equal(kind(syscall), "write", syscall);
  for (const syscall of ["lstat", "stat", "realpath", "readdir", "read", "access"]) assert.equal(kind(syscall), "read", syscall);
  for (const syscall of ["open", undefined]) assert.equal(kind(syscall), "access", String(syscall));
  assert.match(deniedStateText({ reasonCode: "state_access_denied", access: "read", code: "EACCES",
    syscall: "lstat", path: "/data/acc/runtime" }), /^cannot read ACC's state: lstat \/data\/acc\/runtime was refused \(EACCES\)$/);
  assert.match(deniedStateText({ reasonCode: "state_access_denied", access: "access", code: "EPERM",
    syscall: "open", path: "/data/acc/runtime/control.json" }), /^cannot access ACC's state: open /);
  assert.match(DENIED_GUIDANCE.read, /readable/);
  assert.doesNotMatch(DENIED_GUIDANCE.read, /writable/);
  // fchmod on a handle reports no path; the runtime directory admission was writing names it.
  assert.equal(admissionFailure(Object.assign(new Error("EPERM"), { code: "EPERM", syscall: "fchmod" }),
    "/data/acc/runtime").path, "/data/acc/runtime");
  for (const error of [new Error("managed runtime activation in progress"),
    Object.assign(new Error("gone"), { code: "ENOENT", syscall: "open", path: "/x" }), null]) {
    assert.equal(admissionFailure(error), null);
  }
});

async function fixture(t, { pending = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "acc-state-denied-"));
  t.after(() => removeFixture(root));
  const project = path.join(root, "project"), home = path.join(root, "home"), dataHome = path.join(root, "data");
  for (const dir of [project, home, dataHome]) await mkdir(dir);
  const manager = path.join(dataHome, "acc", "runtime"), generation = path.join(manager, "generations", "0.12.1");
  const next = path.join(manager, "generations", "0.12.2");
  for (const [root, version] of [[generation, "0.12.1"], [next, "0.12.2"]]) {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "agents-can-communicate", version }));
  }
  await writeControl(manager, { schemaVersion: 1, active: { root: generation, version: "0.12.1" },
    pending: pending ? { root: next, version: "0.12.2" } : null, phase: pending ? "activating" : "ready",
    auto: false, pin: null, checkedAt: null, home, targets: [], notice: null });
  const admission = { reasonCode: "state_access_denied", access: "write", code: "EPERM", syscall: "mkdir", path: manager };
  const run = async args => {
    let stdout = "";
    const output = name => ({ write(text, done) { if (name === "stdout") stdout += text; done(); } });
    const code = await main([...args, "--cwd", project, "--json"], { cwd: project, dataHome, managerRoot: manager,
      managementOnly: true, admission, env: { HOME: home, ACC_DATA_HOME: dataHome, ACC_NO_UPDATE_CHECK: "1" },
      gitProbe: async () => null, stdout: output("stdout"), stderr: output("stderr") });
    return { code, body: JSON.parse(stdout) };
  };
  return { manager, run };
}

test("a workspace command names the denied state write, never an unfinished update", async t => {
  const f = await fixture(t);
  for (const args of [["status"], ["message", "--to", "p", "--type", "note", "--subject", "s", "--body", "b"]]) {
    const { code, body } = await f.run(args);

    assert.equal(code, EXIT.DATA, args[0]);
    assert.equal(body.error.details.reasonCode, "state_access_denied", args[0]);
    assert.match(body.error.message, /cannot write ACC's state/);
    assert.match(body.error.message, /mkdir .*runtime.* refused \(EPERM\)/);
    assert.match(body.error.message, /no update is pending/);
    assert.doesNotMatch(body.error.message, /retry after the update|run acc update/);
  }
});

test("doctor reports the denied state write and the ready runtime, with permission guidance", async t => {
  const f = await fixture(t);
  const { code, body } = await f.run(["doctor"]);

  assert.equal(code, EXIT.OK);
  assert.equal(body.data.workspaceInspection, "state_access_denied");
  assert.equal(body.data.admission.syscall, "mkdir");
  assert.equal(body.data.update.phase, "ready");
  assert.equal(body.data.update.pending, null);
  assert.doesNotMatch(JSON.stringify(body.data.remediation), /acc update/);
  assert.match(JSON.stringify(body.data.remediation), /sandbox/);
});

test("a denied state write during a pending update still names the update", async t => {
  const f = await fixture(t, { pending: true });
  const { body } = await f.run(["status"]);

  assert.equal(body.error.details.reasonCode, "state_access_denied");
  assert.match(body.error.message, /0\.12\.2 is pending/);
  assert.doesNotMatch(body.error.message, /no update is pending/);
});

// The production denial on macOS, without a sandbox: a directory its owner made
// immutable refuses mkdir and fchmod with EPERM, as the sandboxes did.
const immutable = process.platform === "darwin" ? false : "chflags uchg is macOS's; the classification above runs everywhere";
const run = promisify(execFile);

test("an installed entry under a denied data home says so, and a hook still fails open", { skip: immutable }, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-entry-denied-")));
  const manager = path.join(root, "acc", "runtime");
  const generation = path.join(manager, "generations", "0.12.1");
  await mkdir(path.join(generation, "bin", "entrypoints"), { recursive: true });
  for (const kind of ["acc", "acc-hook"]) {
    await writeFile(path.join(generation, "bin", "entrypoints", `${kind}.mjs`),
      // The real main's answer is covered above; this one leaves the launcher's own.
      "export async function main() { throw new Error('fixture runtime'); }\n");
  }
  await writeControl(manager, { schemaVersion: 1, active: { root: generation, version: "0.12.1" }, pending: null,
    phase: "ready", auto: false, pin: null, checkedAt: null, home: root, targets: [], notice: null });
  await writeFile(path.join(manager, "reclaim.json"), JSON.stringify({ schemaVersion: 1, activeRoot: generation }));
  await run("chflags", ["uchg", manager]);
  t.after(async () => { await run("chflags", ["nouchg", manager]); await removeFixture(root); });

  const entry = new URL("../src/managed-runtime/entry.mjs", import.meta.url).href;
  const start = kind => {
    const code = `process.argv = [process.execPath, "fixture", "status"];
import {runEntry} from ${JSON.stringify(entry)}; await runEntry(${JSON.stringify({
      kind, managerRoot: manager, packageRoot: path.join(root, "missing-source") })});`;
    const cp = spawn(process.execPath, ["--input-type=module", "-e", code],
      { env: { ...process.env, ACC_NO_UPDATE_CHECK: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    cp.stderr.on("data", chunk => { stderr += chunk; });
    return once(cp, "exit").then(([exitCode]) => ({ exitCode, stderr }));
  };

  const cli = await start("acc");
  assert.equal(cli.exitCode, 4);
  assert.match(cli.stderr, /cannot write ACC's state/);
  assert.match(cli.stderr, /refused \(EPERM\)/);
  assert.doesNotMatch(cli.stderr, /retry after the update/);

  const hook = await start("acc-hook");
  assert.equal(hook.exitCode, 0);
  // Hook warnings carry no paths or error details beyond the code.
  assert.match(hook.stderr, /^acc: coordination unavailable: cannot write ACC's state \(EPERM\); session may continue\n$/);
  assert.doesNotMatch(hook.stderr, /during runtime update/);
});
