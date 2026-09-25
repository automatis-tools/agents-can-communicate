import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { renderCommandShim } from "../helpers/legacy-shell-bootstrap.mjs";

// A `claude` shim that ACC 0.7.x wrote stays on a user's PATH until the next
// `acc install` or `acc update` retires it. Until then it must launch the plain
// vendor command: never the development-channel flag, never an exported policy.
const repo = fileURLToPath(new URL("../..", import.meta.url));
const stub = path.join(repo, "bin", "entrypoints", "acc-bootstrap.mjs");
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

test("a 0.7.x shim whose launcher ACC removed runs the vendor command untouched", async t => {
  const here = await place(t);
  const shim = await shimIn(here, { bootstrap: path.join(here.root, "removed", "acc-bootstrap.mjs"),
    prefixArgs: ["--dangerously-load-development-channels", "plugin:agents-can-communicate@acc-local"] });
  const result = await run(shim, USER_ARGS, {});
  const seen = await observed(here.out);
  assert.equal(seen.pid, result.pid, "the shim must exec, not wrap, the vendor");
  assert.equal(seen.policy, "<unset>");
  assert.deepEqual(seen.args, USER_ARGS, "no development-channel flag may be added");
});

test("a 0.7.x launcher that reaches the bootstrap stub runs the vendor command untouched", async t => {
  const here = await place(t);
  // What a 0.7.x managed launcher does with the active generation's entrypoint.
  const launcher = path.join(here.root, "acc-bootstrap-launcher.mjs");
  await writeFile(launcher, `const m = await import(${JSON.stringify(pathToFileURL(stub).href)});\n`
    + "await m.main({});\n");
  const shim = await shimIn(here, { bootstrap: launcher,
    prefixArgs: ["--dangerously-load-development-channels", "plugin:agents-can-communicate@acc-local"] });
  const result = await run(shim, ["hello"], {});
  const seen = await observed(here.out);
  assert.equal(seen.pid, result.pid);
  assert.equal(seen.policy, "<unset>");
  assert.deepEqual(seen.args, ["hello"]);
  assert.equal(result.stdout, "");
});
