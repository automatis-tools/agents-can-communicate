import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const entry = new URL("../src/managed-runtime/entry.mjs", import.meta.url).href;
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-entry-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const managerRoot = path.join(root, "acc", "runtime");
  const runtime = { version: "0.4.0", root: path.join(managerRoot, "generations", "0.4.0-test") };
  await mkdir(path.join(runtime.root, "bin", "entrypoints"), { recursive: true });
  const marker = path.join(root, "imported");
  for (const kind of ["acc", "acc-hook", "acc-mcp", "acc-bootstrap", "acc-claude-channel"]) {
    await writeFile(path.join(runtime.root, "bin", "entrypoints", `${kind}.mjs`),
      `import {writeFile,readFile,readdir} from 'node:fs/promises';
`
      + `const dir = ${JSON.stringify(path.join(managerRoot, 'leases'))};
`
      + `const leases = await Promise.all((await readdir(dir)).map(async n=>JSON.parse(await readFile(dir+'/'+n,'utf8'))));
`
      + `if(!leases.some(l=>l.pid===process.pid)) throw new Error('import before admission');
`
      + `await writeFile(${JSON.stringify(marker)},${JSON.stringify(kind)});\n`
      + "export async function main() { process.stdout.write('ready\\n'); process.stdin.resume(); }\n");
  }
  const control = { schemaVersion: 1, active: runtime, pending: null, phase: "ready", auto: false,
    pin: null, checkedAt: null, home: root, targets: [], notice: null };
  await writeFile(path.join(managerRoot, "control.json"), JSON.stringify(control));
  return { root, managerRoot, runtime, marker, control };
}
function child(t, f, kind) {
  const args = kind === "acc-bootstrap" ? ["--adapter", "claude_code", "--real-executable",
    process.execPath, "--data-home", f.root] : [];
  const code = `process.argv = [process.execPath, "fixture", ...${JSON.stringify(args)}];
import {runEntry} from ${JSON.stringify(entry)}; await runEntry(${JSON.stringify({
    kind, managerRoot: f.managerRoot, packageRoot: path.join(f.root, "missing-source") })});`;
  const cp = spawn(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, ACC_NO_UPDATE_CHECK: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (cp.exitCode === null) cp.kill("SIGKILL"); });
  let stdout = "", stderr = "";
  cp.stdout.on("data", b => { stdout += b; }); cp.stderr.on("data", b => { stderr += b; });
  const done = once(cp, "exit");
  return { cp, done, output: () => ({ stdout, stderr }) };
}
async function ready(c) {
  for (let i = 0; i < 100; i++) {
    if (c.output().stdout.includes("ready")) return;
    if (c.cp.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.fail(`entry never ready: ${JSON.stringify(c.output())}`);
}

test("all five entry points register the actual process before importing the selected runtime", async t => {
  const f = await fixture(t);
  for (const kind of ["acc", "acc-hook", "acc-mcp", "acc-bootstrap", "acc-claude-channel"]) {
    const c = child(t, f, kind);
    await ready(c);
    assert.equal(await readFile(f.marker, "utf8"), kind);
    const leases = await Promise.all((await readdir(path.join(f.managerRoot, "leases")))
      .filter(n => n.endsWith(".json")).map(async n => JSON.parse(await readFile(path.join(f.managerRoot, "leases", n), "utf8"))));
    assert.equal(leases.some(l => l.pid === c.cp.pid && l.kind === kind && l.runtime.root === f.runtime.root), true);
    assert.equal(c.cp.exitCode, null, "main has returned but idle process is still protected");
    c.cp.stdin.end(); await c.done;
  }
});

test("activation blocks runtime import and hooks still exit successfully", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.managerRoot, "control.json"), JSON.stringify({ ...f.control,
    phase: "activating", pending: f.runtime }));
  const c = child(t, f, "acc-hook");
  const [code] = await c.done;
  assert.equal(code, 0);
  assert.equal(c.output().stdout, "");
  assert.match(c.output().stderr, /coordination unavailable|update/i);
  assert.equal((await readdir(f.root)).includes("imported"), false);
});
