import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { decideNativeCaptures, parseCheckpointArgs, renderDecisionTable }
  from "../../scripts/spikes/check-native-captures.mjs";
import { runProcess } from "../helpers/claude-channel.mjs";

const script = fileURLToPath(new URL("../../scripts/spikes/check-native-captures.mjs",
  import.meta.url));
const LIMITATION = "SECRET-LIMITATION-51ab must not be printed";

function capture(client, result, overrides = {}) {
  const pass = result === "pass";
  return {
    client, version: "1.2.3", platform: "darwin-arm64", observedAt: "2026-09-02T12:00:00.000Z",
    capability: "native_delivery", result, fixture: `${client}-1.2.3`,
    launchMode: "ordinary-command-with-install-time-bootstrap",
    protocolContract: `${client}-protocol-v1`,
    idle: pass ? "offered" : "unobserved", busy: pass ? "queued_after_turn" : "unobserved",
    reply: pass ? "routed" : "unobserved", duplicate: pass ? "same_message_id" : "unobserved",
    fallback: pass ? "queued" : "unobserved", limitations: [LIMITATION], ...overrides,
  };
}

function fixtureDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "acc-checkpoint-"));
  const write = (name, value) => {
    const file = path.join(dir, name);
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  };
  return {
    dir,
    claudePass: write("claude-pass.json", capture("claude-code", "pass")),
    claudeFail: write("claude-fail.json", capture("claude-code", "fail")),
    codexPass: write("codex-pass.json", capture("codex-cli", "pass")),
    codexFail: write("codex-fail.json", capture("codex-cli", "fail")),
    grokFail: write("grok-fail.json", capture("grok", "fail")),
    invalidJson: write("invalid.json", "{ not json"),
    halfProof: write("half.json", capture("codex-cli", "pass", { busy: "unobserved" })),
    wrongClient: write("wrong-client.json", capture("grok", "pass")),
    missing: path.join(dir, "missing.json"),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const withFixtures = fn => async () => {
  const fixtures = fixtureDir();
  try {
    await fn(fixtures);
  } finally {
    fixtures.remove();
  }
};

const run = (args) => runProcess([script, ...args]);

test("Claude Code and Codex passing together proceed", withFixtures(async (f) => {
  const result = await run(["--required", `claude_code=${f.claudePass}`,
    "--required", `codex=${f.codexPass}`]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, [
    "Claude Code  pass     1.2.3  darwin-arm64  claude-code-protocol-v1",
    "Codex        pass     1.2.3  darwin-arm64  codex-cli-protocol-v1",
  ].join("\n") + "\n");
}));

test("Codex failure blocks production implementation", withFixtures(async (f) => {
  const decision = decideNativeCaptures({
    required: [{ client: "claude_code", file: f.claudePass }, { client: "codex", file: f.codexFail }],
  });
  assert.equal(decision.proceed, false);
  assert.deepEqual(decision.blocking, ["codex"]);
  const result = await run(["--required", `claude_code=${f.claudePass}`,
    "--required", `codex=${f.codexFail}`]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^Codex {8}fail/m);
}));

test("Claude Code failure blocks production implementation", withFixtures(async (f) => {
  const decision = decideNativeCaptures({
    required: [{ client: "claude_code", file: f.claudeFail }, { client: "codex", file: f.codexPass }],
  });
  assert.equal(decision.proceed, false);
  assert.deepEqual(decision.blocking, ["claude_code"]);
  const result = await run(["--required", `claude_code=${f.claudeFail}`,
    "--required", `codex=${f.codexPass}`]);
  assert.equal(result.code, 1);
}));

test("an optional Grok failure is printed but does not decide", withFixtures(async (f) => {
  const result = await run(["--required", `claude_code=${f.claudePass}`,
    "--required", `codex=${f.codexPass}`, "--optional", `grok=${f.grokFail}`]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^Grok {9}fail {5}1\.2\.3  darwin-arm64  grok-protocol-v1$/m);
}));

test("absent, invalid, half-proof, and mislabelled captures block when required",
  withFixtures(async (f) => {
    for (const [file, expected] of [
      [f.missing, "absent"], [f.invalidJson, "invalid"], [f.halfProof, "invalid"],
      [f.wrongClient, "invalid"],
    ]) {
      const decision = decideNativeCaptures({
        required: [{ client: "claude_code", file: f.claudePass }, { client: "codex", file }],
      });
      assert.equal(decision.proceed, false, file);
      assert.equal(decision.rows[1].result, expected, file);
    }
  }));

test("the decision table never carries limitations or bodies", withFixtures(async (f) => {
  const result = await run(["--required", `claude_code=${f.claudeFail}`,
    "--required", `codex=${f.codexFail}`, "--optional", `grok=${f.grokFail}`]);
  assert.equal(result.stdout.includes(LIMITATION), false);
  assert.equal(result.stderr.includes(LIMITATION), false);
  assert.equal(result.stdout.split("\n").filter(Boolean).length, 3);
  const rendered = renderDecisionTable(decideNativeCaptures({
    required: [{ client: "codex", file: f.codexFail }] }).rows);
  assert.equal(rendered.includes("limitation"), false);
}));

test("the checkpoint refuses arguments outside its closed usage", async () => {
  assert.equal(parseCheckpointArgs([]), null);
  assert.equal(parseCheckpointArgs(["--required", "codex=relative/path.json"]), null);
  assert.equal(parseCheckpointArgs(["--required", "Codex=/abs.json"]), null);
  assert.equal(parseCheckpointArgs(["--optional", "grok=/abs.json"]), null);
  assert.equal(parseCheckpointArgs(["--wrong", "codex=/abs.json"]), null);
  assert.deepEqual(parseCheckpointArgs(["--required", "codex=/a.json", "--optional", "grok=/b.json"]),
    { required: [{ client: "codex", file: "/a.json" }],
      optional: [{ client: "grok", file: "/b.json" }] });
  const result = await run(["--required", "codex"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /usage:/);
});
