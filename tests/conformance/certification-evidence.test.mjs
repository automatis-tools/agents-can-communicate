import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { PASS_EXPECTATIONS } from "./certification-audit.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const ADAPTERS = [
  ["adapter-claude-code", createClaudeCodeAdapter],
  ["adapter-codex", createCodexAdapter],
  ["adapter-gemini-cli", createGeminiCliAdapter],
  ["adapter-grok", createGrokAdapter],
  ["adapter-kimi", createKimiAdapter],
];

const comparable = item => ({ client: item.client, version: item.version,
  platform: item.platform, observedAt: item.observedAt, capability: item.capability,
  fixture: item.fixture, idleBehavior: item.idleBehavior, busyBehavior: item.busyBehavior,
  authorityLevel: item.authorityLevel, limitations: item.limitations });
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
      assert.equal(packageJson.files.includes("fixtures/"), false,
        "a wildcard fixture directory can publish documentation-derived material");

      const adapter = createAdapter();
      assert.equal(Array.isArray(adapter.certification?.evidence), true);
      const expected = PASS_EXPECTATIONS[packageName];
      assert.deepEqual(adapter.certification.evidence.filter(item => item.result === "pass")
        .map(comparable).sort(byCapability), expected.map(comparable).sort(byCapability),
      "passing certification facts differ from the audited client/version/platform captures");
      for (const item of adapter.certification.evidence) {
        assert.equal(packageJson.files.includes(item.fixture), true,
          `${item.fixture} is absent from the exact package allowlist`);
        assert.equal(packageJson.files.includes(item.provenance), true,
          `${item.provenance} is absent from the exact package allowlist`);
        assert.match(item.provenance ?? "", /^fixtures\/.+\.json$/,
          "certification must reference package-shipped structured provenance");
        assert.match(item.provenanceId ?? "", /^[a-z0-9][a-z0-9-]+$/,
          "certification must select one structured provenance record");
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
        const fixtureDigest = createHash("sha256")
          .update(await readFile(fixturePath)).digest("hex");
        const provenance = JSON.parse(await readFile(path.join(packageRoot, item.provenance),
          "utf8"));
        const provenanceRecord = provenance.captures?.find(record =>
          record.id === item.provenanceId);
        assert.ok(provenanceRecord, `${item.provenanceId} is absent from provenance`);
        for (const key of ["client", "version", "platform", "observedAt", "fixture"]) {
          assert.equal(provenanceRecord[key], item[key],
            `${item.provenanceId} ${key} differs from certification evidence`);
        }
        assert.equal(provenanceRecord.sha256, fixtureDigest,
          `${item.fixture} differs from the audited capture digest`);
        const claim = provenanceRecord.claims?.find(candidate =>
          candidate.capability === item.capability);
        assert.ok(claim, `${item.provenanceId} has no outcome for ${item.capability}`);
        assert.equal(claim.result, item.result, `${item.capability} result was rewritten`);
        if (item.result === "pass") {
          assert.equal(provenanceRecord.event, expectedCapture.event,
            `${item.provenanceId} event differs from the independent audit`);
          assert.equal(provenanceRecord.tool, expectedCapture.tool,
            `${item.provenanceId} tool differs from the independent audit`);
          assert.equal(claim.outcome?.kind, expectedCapture.outcome,
            `${item.provenanceId} outcome differs from the independent audit`);
          assert.equal(claim.outcome.idle, item.idleBehavior);
          assert.equal(claim.outcome.busy, item.busyBehavior);
          assert.equal(claim.outcome.authority, item.authorityLevel);
          assert.deepEqual(claim.outcome.limitations, item.limitations);
        } else {
          assert.equal(claim.outcome?.kind, "native-capture-failed");
        }
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
