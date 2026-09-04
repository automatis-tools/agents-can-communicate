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

  // The version has to be here so an operator can tell whether the reason
  // applies to the client they are running, and it has to be the version the
  // withdrawal was measured on. Naming 0.152.0's absent control socket instead
  // sent them looking for a socket that is present and working.
  assert.match(diagnostics, /0\.152\.1/, "doctor hid which native capture the reason came from");
  assert.match(diagnostics, /workspace/i,
    "doctor hid the client boundary that prevented native delivery");
  // Two things an operator would otherwise try: repairing a config, and
  // stopping or restarting their own daemon. Both are dead ends here.
  assert.match(diagnostics, /not a misconfiguration/i,
    "doctor implied the operator could repair this");
  assert.match(diagnostics, /did not start.*daemon/i,
    "doctor did not state that ACC left client lifecycle alone");
  assert.match(diagnostics, /next-turn.*acc inbox/,
    "doctor did not name the durable fallback");
  assert.doesNotMatch(diagnostics, /control socket.*absent/i,
    "doctor still named the superseded 0.152.0 reason");
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
