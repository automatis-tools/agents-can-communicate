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
