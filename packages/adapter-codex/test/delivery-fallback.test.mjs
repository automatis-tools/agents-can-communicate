import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { effectiveCapabilities } from "@agents-can-communicate/adapter-sdk";

import { createCodexAdapter } from "../src/adapter.mjs";

test("doctor names the failed native capture and durable fallback", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "acc-codex-fallback-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const report = await createCodexAdapter().doctor({ home });
  const diagnostics = report.diagnostics.join(" ");

  assert.match(diagnostics, /0\.152\.0/, "doctor hid which native capture failed");
  assert.match(diagnostics, /control socket.*absent/i,
    "doctor hid the client boundary that prevented native delivery");
  assert.match(diagnostics, /did not start.*daemon/i,
    "doctor did not state that ACC left client lifecycle alone");
  assert.match(diagnostics, /next-turn.*acc inbox/,
    "doctor did not name the durable fallback");
});

test("only the exact captured Codex version keeps certified next-turn delivery", () => {
  const adapter = createCodexAdapter();
  const capabilities = clientVersion => effectiveCapabilities(adapter,
    { clientVersion, platform: "darwin-arm64" }).delivery;

  assert.equal(capabilities("0.147.0").nextTurn, true);
  assert.equal(capabilities("0.147.0").livePush, false);
  assert.equal(capabilities("0.147.0").replyRoute, false);
  for (const version of ["0.152.0", "unknown"]) {
    assert.equal(capabilities(version).nextTurn, false,
      `${version} was promoted to nextTurn without exact passing evidence`);
    assert.equal(capabilities(version).livePush, false);
    assert.equal(capabilities(version).replyRoute, false);
  }
});
