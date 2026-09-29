import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCodexAdapter } from "../src/adapter.mjs";
import { nativeActivationHint } from "../src/native-delivery.mjs";

const embedded = Object.freeze({ state: "degraded", reasonCode: "client_session_embedded", modes: [] });

async function runtime(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "acc-cx-notice-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const ask = (runtimeDir, sessionId, nativeBinding = embedded) => nativeActivationHint({
  event: { sessionId, cwd: "/work" }, nativeBinding, runtimeDir, clientPid: 4242,
  env: { HOME: "/Users/someone" } });

test("the Codex adapter offers the runner a notice for an embedded chat", () => {
  assert.equal(createCodexAdapter().nativeActivationHint, nativeActivationHint);
});

test("an embedded chat is told once why live delivery is off and how to get it", async t => {
  const runtimeDir = await runtime(t);
  const first = await ask(runtimeDir, "thread-1");
  assert.equal(typeof first.line, "string");
  assert.equal(first.line.includes("\n"), false);
  assert.ok(Buffer.byteLength(first.line) <= 512);
  assert.match(first.line, /embedded/);
  assert.match(first.line, /next prompt/);
  assert.match(first.line, /new Codex chat/);
  assert.match(first.line, /codex app-server daemon start/);
  assert.equal(await ask(runtimeDir, "thread-1"), null, "one delivered notice per chat");
  assert.equal(typeof (await ask(runtimeDir, "thread-2"))?.line, "string", "another chat is told too");
});

test("a notice the runner did not deliver is offered again", async t => {
  const runtimeDir = await runtime(t);
  const first = await ask(runtimeDir, "thread-1");
  await first.release();
  assert.equal((await ask(runtimeDir, "thread-1"))?.line, first.line);
});

test("no notice without an embedded chat", async t => {
  const runtimeDir = await runtime(t);
  for (const nativeBinding of [{ state: "degraded", reasonCode: "handshake_failed", modes: [] },
    { state: "active", reasonCode: null, modes: ["livePush"] },
    { state: "off", reasonCode: null, modes: [] },
    { state: "unsupported", reasonCode: "client_session_embedded", modes: [] }, null]) {
    assert.equal(await ask(runtimeDir, "thread-1", nativeBinding), null);
  }
  assert.equal(await nativeActivationHint({ event: {}, nativeBinding: embedded, runtimeDir }), null);
});
