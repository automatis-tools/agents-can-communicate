import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { effectiveCapabilities } from "@agents-can-communicate/adapter-sdk";

import { createCodexAdapter } from "../src/adapter.mjs";

test("doctor explains per-session native eligibility and durable fallback", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "acc-codex-fallback-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const report = await createCodexAdapter().doctor({ home });
  const diagnostics = report.diagnostics.join(" ");

  assert.match(diagnostics, /0\.152\.1.*darwin-arm64/, "doctor names the captured native minimum");
  assert.match(diagnostics, /recorded.*consent/, "current recipient consent is required");
  assert.match(diagnostics, /exact.*thread.*cwd/i, "a session needs verified identity");
  assert.match(diagnostics, /Embedded.*unreachable/i, "unreachable sessions retain fallback");
  assert.match(diagnostics, /does not start.*daemon/i, "ACC does not own the daemon lifecycle");
  assert.match(diagnostics, /next-turn.*acc inbox/,
    "doctor did not name the durable fallback");
  assert.doesNotMatch(diagnostics, /no honest way|not a misconfiguration|requires runs the session/i,
    "historical remote-wrapper failure cannot become a universal workspace impossibility");
});

test("legacy next-turn and captured LocalDaemon delivery keep distinct evidence boundaries", () => {
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
  for (const version of ["0.152.1", "0.153.4"]) {
    assert.equal(capabilities(version).nextTurn, false,
      `${version} inherited a next-turn claim from the 0.147.0 hook capture`);
    assert.equal(capabilities(version).livePush, true,
      `${version} lost its captured LocalDaemon capability`);
    assert.equal(capabilities(version).replyRoute, false,
      `${version} gained an unobserved native reply route`);
  }
});

// Replacing this with a launcher, shell bootstrap, or teardown command would
// make the assertion fail. Codex owns its argv and daemon lifecycle.
test("native activation reuses only an already-running LocalDaemon", () => {
  const plan = createCodexAdapter().planNativeActivation({ detection: {
    realExecutable: "/opt/codex/bin/codex",
  } });

  assert.deepEqual(plan, { eligible: true, reasonCode: null, mechanisms: [{
    kind: "native-service", serviceId: "codex-app-server", preExisting: true,
    applyCommand: null, teardownCommand: null,
  }] });
});

test("uncaptured platforms retain durable fallback", () => {
  const delivery = effectiveCapabilities(createCodexAdapter(),
    { clientVersion: "0.152.1", platform: "linux-arm64" }).delivery;

  assert.equal(delivery.nextTurn, false);
  assert.equal(delivery.livePush, false);
  assert.equal(delivery.replyRoute, false);
});
