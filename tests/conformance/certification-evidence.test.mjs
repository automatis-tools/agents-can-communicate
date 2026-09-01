import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createClaudeCodeAdapter } from "@agents-can-communicate/adapter-claude-code";
import { createCodexAdapter } from "@agents-can-communicate/adapter-codex";
import { createGeminiCliAdapter } from "@agents-can-communicate/adapter-gemini-cli";
import { createGrokAdapter } from "@agents-can-communicate/adapter-grok";
import { createKimiAdapter } from "@agents-can-communicate/adapter-kimi";
import { CAPABILITY_SHAPE } from "@agents-can-communicate/adapter-sdk";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const ADAPTERS = [
  ["adapter-claude-code", createClaudeCodeAdapter],
  ["adapter-codex", createCodexAdapter],
  ["adapter-gemini-cli", createGeminiCliAdapter],
  ["adapter-grok", createGrokAdapter],
  ["adapter-kimi", createKimiAdapter],
];

const PASS_EXPECTATIONS = Object.freeze({
  "adapter-claude-code": [
    ["lifecycle.sessionStart", "fixtures/SessionStart.json", "SessionStart", null],
    ["lifecycle.sessionEnd", "fixtures/SessionEnd.json", "SessionEnd", null],
    ["context.beforeTurnInjection", "fixtures/UserPromptSubmit.json", "UserPromptSubmit", null],
    ["guards.beforeWrite", "fixtures/PreToolUse-Edit.json", "PreToolUse", "Edit"],
    ["guards.beforeShell", "fixtures/PreToolUse.json", "PreToolUse", "Bash"],
    ["delivery.nextTurn", "fixtures/UserPromptSubmit.json", "UserPromptSubmit", null],
  ].map(([capability, fixture, event, tool]) =>
    ({ client: "claude-code", version: "2.1.233", platform: "darwin-arm64",
      capability, fixture, event, tool })),
  "adapter-codex": [
    ["lifecycle.sessionStart", "fixtures/SessionStart.json", "SessionStart", null],
    ["lifecycle.sessionEnd", "fixtures/SessionEnd.json", "SessionEnd", null],
    ["context.beforeTurnInjection", "fixtures/UserPromptSubmit.json", "UserPromptSubmit", null],
    ["guards.beforeWrite", "fixtures/PreToolUse.json", "PreToolUse", "apply_patch"],
    ["delivery.nextTurn", "fixtures/UserPromptSubmit.json", "UserPromptSubmit", null],
  ].map(([capability, fixture, event, tool]) =>
    ({ client: "codex-cli", version: "0.147.0", platform: "darwin-arm64",
      capability, fixture, event, tool })),
  "adapter-gemini-cli": [
    ["lifecycle.sessionStart", "fixtures/SessionStart.json", "SessionStart", null],
    ["lifecycle.sessionEnd", "fixtures/SessionEnd.json", "SessionEnd", null],
    ["context.beforeTurnInjection", "fixtures/BeforeAgent.json", "BeforeAgent", null],
    ["guards.beforeWrite", "fixtures/BeforeTool.json", "BeforeTool", "write_file"],
    ["guards.beforeShell", "fixtures/BeforeTool-shell.json", "BeforeTool", "run_shell_command"],
    ["delivery.nextTurn", "fixtures/BeforeAgent.json", "BeforeAgent", null],
  ].map(([capability, fixture, event, tool]) =>
    ({ client: "gemini-cli", version: "0.37.0", platform: "darwin-arm64",
      capability, fixture, event, tool })),
  "adapter-grok": [],
  "adapter-kimi": [
    ["lifecycle.sessionStart", "fixtures/SessionStart.json", "SessionStart", null],
    ["lifecycle.heartbeat", "fixtures/SessionHeartbeat.json", "SessionHeartbeat", null],
    ["context.beforeTurnInjection", "fixtures/UserPromptSubmit.json", "UserPromptSubmit", null],
    ["guards.beforeWrite", "fixtures/PreToolUse-Write.json", "PreToolUse", "Write"],
    ["guards.beforeShell", "fixtures/PreToolUse-Bash.json", "PreToolUse", "Bash"],
    ["delivery.nextTurn", "fixtures/UserPromptSubmit.json", "UserPromptSubmit", null],
  ].map(([capability, fixture, event, tool]) =>
    ({ client: "kimi", version: "0.36.1", platform: "darwin-arm64",
      capability, fixture, event, tool })),
});

const comparable = item => ({ client: item.client, version: item.version,
  platform: item.platform, capability: item.capability, fixture: item.fixture });
const byCapability = (left, right) => left.capability.localeCompare(right.capability);

const trueCapabilities = adapter => Object.entries(CAPABILITY_SHAPE)
  .flatMap(([group, names]) => names
    .filter(name => adapter.capabilities[group][name] === true)
    .map(name => `${group}.${name}`));

for (const [packageName, createAdapter] of ADAPTERS) {
  test(`${packageName}: certification evidence is shipped and resolves to captured JSON`,
    async () => {
      const packageRoot = path.join(repoRoot, "packages", packageName);
      const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json")));
      assert.equal(packageJson.files.includes("certification.json"), true,
        "certification.json is absent from package files");
      assert.equal(packageJson.files.includes("fixtures/"), true,
        "captured fixtures are absent from package files");

      const adapter = createAdapter();
      assert.equal(Array.isArray(adapter.certification?.evidence), true);
      const expected = PASS_EXPECTATIONS[packageName];
      assert.deepEqual(adapter.certification.evidence.filter(item => item.result === "pass")
        .map(comparable).sort(byCapability), expected.map(comparable).sort(byCapability),
      "passing certification facts differ from the audited client/version/platform captures");
      for (const item of adapter.certification.evidence) {
        assert.match(item.fixture, /^fixtures\/(?!.*(?:^|\/)\.\.\/).+\.json$/,
          "certification must reference package-local captured JSON, not documentation");
        const fixturePath = path.join(packageRoot, item.fixture);
        let capture;
        try {
          capture = JSON.parse(await readFile(fixturePath, "utf8"));
        } catch (error) {
          assert.fail(`${packageName}: missing certification fixture ${item.fixture}: ${error.message}`);
        }
        const expectedCapture = expected.find(candidate => candidate.capability === item.capability
          && candidate.fixture === item.fixture);
        if (item.result === "pass") {
          assert.equal(capture.hook_event_name ?? capture.hookEventName, expectedCapture.event,
            `${item.fixture} does not contain the certified hook event`);
          assert.equal(capture.tool_name ?? capture.toolName ?? null, expectedCapture.tool,
            `${item.fixture} does not contain the certified tool path`);
        }
        if (capture.result !== undefined) {
          assert.equal(item.result, capture.result,
            `${item.fixture} failure/pass result was rewritten`);
          for (const key of ["client", "version", "platform", "observedAt"]) {
            assert.equal(item[key], capture[key], `${item.fixture} ${key} was rewritten`);
          }
          assert.equal(item.idleBehavior, capture.idle, `${item.fixture} idle result was rewritten`);
          assert.equal(item.busyBehavior, capture.busy, `${item.fixture} busy result was rewritten`);
          assert.deepEqual(item.limitations, capture.limitations,
            `${item.fixture} limitations were rewritten`);
        }
      }

      const passing = new Set(adapter.certification.evidence
        .filter(item => item.result === "pass").map(item => item.capability));
      for (const capability of trueCapabilities(adapter)) {
        assert.equal(passing.has(capability), true,
          `${capability} lacks package-shipped passing evidence`);
      }
    });
}

test("failed native captures remain explicit false evidence", () => {
  const codex = createCodexAdapter().certification.evidence;
  const claude = createClaudeCodeAdapter().certification.evidence;
  for (const [evidence, fixture] of [
    [codex, "fixtures/delivery/codex-cli-0.152.0.json"],
    [claude, "fixtures/delivery/claude-code-2.1.252.json"],
  ]) {
    for (const capability of ["delivery.livePush", "delivery.replyRoute"]) {
      assert.equal(evidence.some(item => item.capability === capability
        && item.fixture === fixture && item.result === "fail"), true,
      `${capability} failure evidence was omitted`);
    }
  }
});
