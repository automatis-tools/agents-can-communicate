import assert from "node:assert/strict";
import test from "node:test";

import { parseClientVersion, probeClientVersion } from "../src/client-version.mjs";

test("the hook process parses client-shaped version banners", () => {
  assert.equal(parseClientVersion("codex-cli 0.152.0"), "0.152.0");
  assert.equal(parseClientVersion("2.1.252 (Claude Code)"), "2.1.252");
  assert.equal(parseClientVersion("build from source"), null);
});

test("session attach probes the actual executable instead of a manifest constant", async () => {
  const version = await probeClientVersion({
    client: { command: process.execPath, versionArgs: ["--version"] },
  });

  assert.equal(version, process.versions.node);
});
