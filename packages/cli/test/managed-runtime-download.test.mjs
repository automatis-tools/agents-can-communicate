import assert from "node:assert/strict";
import test from "node:test";
import { fetchRelease } from "../src/managed-runtime/download.mjs";

test("automatic release discovery accepts only exact stable package identity and integrity", async () => {
  const body = { name: "agents-can-communicate", version: "0.4.1", dist: { integrity: `sha512-${Buffer.alloc(64).toString('base64')}` } };
  let request;
  const get = async url => { request = url; return { ok: true, json: async () => body }; };
  assert.equal((await fetchRelease({ get, env: {} })).version, "0.4.1");
  assert.match(request, /agents-can-communicate\/latest$/);
  await fetchRelease({ get, pin: "0.4.1", env: {} });
  assert.match(request, /agents-can-communicate\/0\.4\.1$/);
  for (const value of ["0.4.2-beta.1", "garbage", "1.02.3"]) {
    await assert.rejects(fetchRelease({ get, pin: value, env: {} }), /stable|version/);
  }
  body.version = "0.4.2-beta.1";
  await assert.rejects(fetchRelease({ get, env: {} }), /stable|version/);
  body.version = "0.4.1"; body.dist.integrity = "sha512-not-a-digest";
  await assert.rejects(fetchRelease({ get, env: {} }), /integrity/);
  body.dist.integrity = `sha512-${Buffer.alloc(64).toString('base64')}`; body.name = "other";
  await assert.rejects(fetchRelease({ get, env: {} }), /identity/);
});

// On Windows the `npm` beside node.exe is a shell script; node ran it as
// JavaScript and every download failed. npm's own entry is npm-cli.js.
test("windows: the download runs npm's own script, not the shell script named npm", async () => {
  const { npmCli } = await import("../src/managed-runtime/download.mjs");
  const found = [];
  const realpath = async file => {
    found.push(file);
    if (file === "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js") return file;
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  assert.equal(await npmCli({ Path: "C:\\Windows" }, { platform: "win32",
    execPath: "C:\\Program Files\\nodejs\\node.exe", realpath }),
  "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js");
  assert.equal(found.some(file => /\\npm$/.test(file)), false);
});
