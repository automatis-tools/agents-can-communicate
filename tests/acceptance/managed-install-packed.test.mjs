import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createPackedAcc } from "../helpers/packed-acc.mjs";

const run = promisify(execFile);
test("normal installed ACC enrolls automatic updates and surviving stable integration commands", async t => {
  const f = await createPackedAcc(t);
  await f.setClientVersions({ claude: "2.1.259", codex: "0.135.0" });
  const env = { ...f.env, ACC_NO_UPDATE_CHECK: "1" };
  const adapters = ["claude_code", "codex", "gemini_cli", "grok", "kimi"];
  await f.acc(["install", ...adapters.flatMap(id => ["--adapter", id])], env);
  const root = path.join(f.dataHome, "acc", "runtime");
  const control = JSON.parse(await readFile(path.join(root, "control.json"), "utf8"));
  assert.equal(control.auto, true);
  assert.equal(control.phase, "ready");
  assert.equal(control.active.version, f.manifest.version);
  assert.deepEqual(control.targets.sort(), adapters.sort());
  const entries = await readdir(f.clientHome, { recursive: true });
  const skills = entries.filter(n => n.endsWith("SKILL.md"));
  assert.equal(skills.length >= 4, true);
  // Each example names one shim, so the guarantee that an agent reaches the
  // managed runtime rather than some other install now lives one level down.
  for (const skill of skills) {
    const text = await readFile(path.join(f.clientHome, skill), "utf8");
    const [, shim] = /"([^"]*acc-cli\.sh)"/.exec(text) ?? [];
    assert.equal(typeof shim, "string", skill);
    assert.equal((await readFile(shim, "utf8")).includes(path.join(root, "bin", "acc.mjs")),
      true, shim);
  }
  const hooks = entries.filter(n => n.endsWith("acc-hook.sh"));
  assert.equal(hooks.length >= 4, true);
  for (const hook of hooks) assert.equal((await readFile(path.join(f.clientHome, hook), "utf8"))
    .includes(path.join(root, "bin", "acc-hook.mjs")), true, hook);
  for (const name of ["acc", "acc-hook", "acc-mcp", "acc-bootstrap", "acc-claude-channel"]) {
    assert.match(await readFile(path.join(root, "bin", `${name}.mjs`), "utf8"), /runEntry/);
  }
  await rm(f.installed, { recursive: true });
  const result = await run(process.execPath, [path.join(root, "bin", "acc.mjs"), "version", "--json"],
    { cwd: f.project, env });
  assert.equal(JSON.parse(result.stdout).data.version, f.manifest.version);
  const hook = run(process.execPath, [path.join(root, "bin", "acc-hook.mjs"), "claude_code"],
    { cwd: f.project, env });
  hook.child.stdin.end('{}');
  await hook;
  // Recovery remains reachable while normal workspace commands are fenced.
  await writeFile(path.join(root, "control.json"), JSON.stringify({ ...control,
    phase: "activating", pending: control.active }));
  const invoke = args => run(process.execPath, [path.join(root, "bin", "acc.mjs"), ...args],
    { cwd: f.project, env });
  assert.equal(JSON.parse((await invoke(["help", "--json"])).stdout).ok, true);
  for (const args of [["status", "--json"], ["message", "--subject", "x", "--body", "--help", "--json"]]) {
    const error = await invoke(args).then(() => null, value => value);
    assert.equal(error?.code, 4);
    assert.match(error.stdout, /runtime unavailable/);
  }
});
