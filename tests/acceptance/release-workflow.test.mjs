import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createClaudeCodeAdapter } from "@agents-can-communicate/adapter-claude-code";
import { createCodexAdapter } from "@agents-can-communicate/adapter-codex";
import { createAntigravityAdapter } from "@agents-can-communicate/adapter-antigravity";
import { createGeminiCliAdapter } from "@agents-can-communicate/adapter-gemini-cli";
import { createGrokAdapter } from "@agents-can-communicate/adapter-grok";
import { createKimiAdapter } from "@agents-can-communicate/adapter-kimi";

const repo = path.resolve(import.meta.dirname, "..", "..");

// Every adapter that declares delivery.livePush must have, together, all three:
// a passing livePush capture at the anchored version/platform, a minimum anchor
// that matches that capture, and an installed-path process test. A true
// capability missing any one of them is a release that cannot honour its own
// claim, so this gate fails the release rather than shipping it.
const NATIVE_PROCESS_TEST = Object.freeze({
  antigravity: "tests/process/antigravity-native-delivery.test.mjs",
  claude_code: "tests/process/claude-native-delivery.test.mjs",
  codex: "tests/process/codex-native-delivery.test.mjs",
});

test("a shipped livePush capability has a capture, a matching anchor, and an acceptance test",
  async () => {
    for (const create of [createAntigravityAdapter, createClaudeCodeAdapter, createCodexAdapter,
      createGeminiCliAdapter, createGrokAdapter, createKimiAdapter]) {
      const adapter = create();
      if (adapter.capabilities.delivery?.livePush !== true) {
        assert.equal(adapter.nativeDelivery, undefined,
          `${adapter.id} declares a native contract without a live capability`);
        continue;
      }
      const contract = adapter.nativeDelivery;
      assert.notEqual(contract, undefined, `${adapter.id} claims livePush with no native contract`);
      const client = adapter.client.certificationName ?? adapter.client.command;
      for (const anchor of contract.anchors) {
        // An anchor for another product the adapter serves names that product.
        const owner = anchor.client ?? client;
        const passing = adapter.certification.evidence.some(item => item.result === "pass"
          && item.capability === "delivery.livePush" && item.client === owner
          && item.version === anchor.version);
        assert.equal(passing, true,
          `${adapter.id} anchor ${anchor.version} has no passing livePush capture`);
      }
      assert.equal(contract.anchors.some(anchor => anchor.version === contract.minimum), true,
        `${adapter.id} minimum ${contract.minimum} is not the first passing capture`);
      const processTest = NATIVE_PROCESS_TEST[adapter.id];
      assert.equal(typeof processTest, "string",
        `${adapter.id} ships livePush with no named installed-path acceptance test`);
      const listed = await readdir(path.join(repo, "tests", "process"));
      assert.equal(listed.includes(path.basename(processTest)), true,
        `${adapter.id} names ${processTest} but it is not present`);
    }
  });

test("the release workflow creates its pack destination before npm writes there", async () => {
  const workflow = await readFile(path.join(repo, ".github", "workflows", "release.yml"),
    "utf8");
  const prepare = workflow.indexOf("run: mkdir -p dist");
  const pack = workflow.indexOf("run: npm pack --pack-destination dist");

  assert.notEqual(prepare, -1, "release.yml never creates dist/");
  assert.ok(prepare < pack, "release.yml creates dist/ only after npm needs it");
});
