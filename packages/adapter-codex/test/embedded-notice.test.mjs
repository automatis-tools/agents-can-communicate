import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCodexAdapter } from "../src/adapter.mjs";
import { injectOutcome } from "../src/hooks.mjs";
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
  assert.match(first.line, /shown the user/, "the model knows the user saw it");
  assert.equal(first.userMessage.includes("\n"), false);
  assert.ok(Buffer.byteLength(first.userMessage) <= 512);
  assert.match(first.userMessage, /live peer delivery is off/);
  assert.match(first.userMessage, /new Codex chat/);
  assert.match(first.userMessage, /codex app-server daemon start/);
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

// Measured 2026-09-29 on Codex 0.159.1: `codex --search` and `codex -c ...`
// run embedded while the daemon runs, so a new chat started the same way is
// embedded again. The advice names the option instead.
test("a chat a launch option kept embedded is told to start Codex without it", async t => {
  const runtimeDir = await runtime(t);
  for (const [option, setting] of [["--search", true], ["-c", true], ["--profile", true],
    ["--enable", true], ["--no-daemon", false], ["--oss", false], ["--strict-config", false]]) {
    const hint = await ask(runtimeDir, `thread${option}`, { ...embedded, launchOption: option });
    for (const text of [hint.line, hint.userMessage]) {
      assert.equal(text.includes("\n"), false, option);
      assert.ok(Buffer.byteLength(text) <= 512, option);
      assert.ok(text.includes(`start Codex without \`${option}\``), `${option}: ${text}`);
      assert.equal(/config\.toml/.test(text), setting, `${option}: ${text}`);
      assert.doesNotMatch(text, /new Codex chat|daemon start/, option);
    }
  }
});

test("an option the binding cannot vouch for is left out of the advice", async t => {
  const runtimeDir = await runtime(t);
  const hint = await ask(runtimeDir, "thread-1", { ...embedded, launchOption: "--search; rm -rf /" });
  assert.match(hint.userMessage, /new Codex chat/);
  assert.doesNotMatch(hint.userMessage, /rm -rf/);
});

// Codex shows a hook's `systemMessage` to the user and passes only
// `additionalContext` to the model - measured on 0.147.0, 0.155.1 and 0.159.1.
test("a turn with a notice for the user prints it as the hook's systemMessage", () => {
  assert.deepEqual(injectOutcome("context for the model"),
    { stdout: "context for the model", stderr: "", exitCode: 0 }, "plain text otherwise");
  const outcome = injectOutcome("context for the model", { userMessage: "ACC: for the user." });
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(JSON.parse(outcome.stdout), { systemMessage: "ACC: for the user.",
    hookSpecificOutput: { hookEventName: "UserPromptSubmit",
      additionalContext: "context for the model" } });
});
