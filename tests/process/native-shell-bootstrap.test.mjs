import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { renderCommandShim } from "../../packages/installer/src/shell-bootstrap.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const realBootstrap = path.join(repo, "bin", "acc-bootstrap.mjs");
const USER_ARGS = ["a b", "it's", "*", "", "--flag=value", "$HOME", "`x`", "-n"];

// The vendor is a shell script that records its own pid, its arguments byte for
// byte, and whether the policy variable reached it - the three facts a shim has
// to get right.
async function vendorIn(root) {
  const out = path.join(root, "out");
  const vendor = path.join(root, "vendor");
  await writeFile(vendor, ["#!/bin/sh", `printf '%s\\n' "$$" > ${JSON.stringify(out)}.pid`,
    `printf '%s\\n' "\${ACC_NATIVE_DELIVERY_POLICY-<unset>}" > ${JSON.stringify(out)}.policy`,
    `: > ${JSON.stringify(out)}.args`,
    `for a in "$@"; do printf '%s\\0' "$a" >> ${JSON.stringify(out)}.args; done`, ""].join("\n"),
  { mode: 0o700 });
  return { vendor, out };
}

async function fakeBootstrapIn(root) {
  const file = path.join(root, "fake-bootstrap.mjs");
  await writeFile(file, `process.exit(process.env.FAKE_PROBE === "ok" ? 0 : 1);\n`);
  return file;
}

async function place(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-shim-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { vendor, out } = await vendorIn(root);
  const bootstrap = await fakeBootstrapIn(root);
  return { root, vendor, out, bootstrap };
}

function run(file, args, env) {
  return new Promise(resolve => {
    const child = spawn(file, args, { env: { PATH: process.env.PATH, ...env },
      stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.on("exit", code => resolve({ code, pid: child.pid, stdout }));
  });
}

async function observed(out) {
  const args = (await readFile(`${out}.args`, "utf8")).split("\0");
  args.pop();
  return { pid: Number((await readFile(`${out}.pid`, "utf8")).trim()),
    policy: (await readFile(`${out}.policy`, "utf8")).trim(), args };
}

async function shimIn(place, { node = process.execPath, bootstrap = place.bootstrap,
  prefixArgs = ["--captured-flag", "captured value"], livePolicy = "actionable" } = {}) {
  const file = path.join(place.root, "claude");
  await writeFile(file, renderCommandShim({ node, bootstrap, dataHome: place.root,
    entry: { adapterId: "claude_code", command: "claude", realExecutable: place.vendor,
      prefixArgs, livePolicy } }), { mode: 0o700 });
  return file;
}

test("a passing check exports the owned policy, prepends the captured args, and execs in place",
  async t => {
    const here = await place(t);
    const shim = await shimIn(here);
    const result = await run(shim, USER_ARGS, { FAKE_PROBE: "ok" });
    const seen = await observed(here.out);
    assert.equal(result.code, 0);
    assert.equal(seen.pid, result.pid, "exec did not replace the shim process");
    assert.equal(seen.policy, "actionable");
    assert.deepEqual(seen.args, ["--captured-flag", "captured value", ...USER_ARGS]);
    assert.equal(result.stdout, "");
  });

test("a failed probe launches the untouched vendor command", async t => {
  const here = await place(t);
  const shim = await shimIn(here);
  const result = await run(shim, USER_ARGS, { FAKE_PROBE: "no", ACC_NATIVE_DELIVERY_POLICY: "all" });
  const seen = await observed(here.out);
  assert.equal(seen.pid, result.pid);
  assert.equal(seen.policy, "<unset>", "a fallback launch must not inherit a policy");
  assert.deepEqual(seen.args, USER_ARGS);
});

test("ACC_BYPASS=1 never runs the check and unsets the reserved policy", async t => {
  const here = await place(t);
  const shim = await shimIn(here, { bootstrap: path.join(here.root, "explodes.mjs") });
  const result = await run(shim, USER_ARGS, { ACC_BYPASS: "1", ACC_NATIVE_DELIVERY_POLICY: "all",
    FAKE_PROBE: "ok" });
  const seen = await observed(here.out);
  assert.equal(seen.pid, result.pid);
  assert.equal(seen.policy, "<unset>");
  assert.deepEqual(seen.args, USER_ARGS);
});

test("a missing Node executable or a damaged ACC file falls open to the vendor command",
  async t => {
    for (const patch of [{ node: path.join("/", "nonexistent", "node") },
      { bootstrap: path.join("/", "nonexistent", "acc-bootstrap.mjs") }]) {
      const here = await place(t);
      const shim = await shimIn(here, patch);
      const result = await run(shim, ["only"], { FAKE_PROBE: "ok" });
      const seen = await observed(here.out);
      assert.equal(seen.pid, result.pid);
      assert.equal(seen.policy, "<unset>");
      assert.deepEqual(seen.args, ["only"]);
    }
  });

test("the shipped bootstrap refuses an adapter without a native contract and writes nothing to stdout",
  async t => {
    const here = await place(t);
    const shim = await shimIn(here, { bootstrap: realBootstrap });
    const result = await run(shim, ["hello"], { ACC_BOOTSTRAP_DEBUG: "1" });
    const seen = await observed(here.out);
    assert.equal(seen.pid, result.pid);
    assert.equal(seen.policy, "<unset>");
    assert.deepEqual(seen.args, ["hello"]);
    assert.equal(result.stdout, "");
    const usage = await run(process.execPath, [realBootstrap, "--adapter"], {});
    assert.equal(usage.code, 2);
    assert.equal(usage.stdout, "");
  });
