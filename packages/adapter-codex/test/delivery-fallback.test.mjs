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

  assert.equal(capabilities("0.146.0").livePush, false,
    "a client older than every capture stays unproven");
  assert.equal(capabilities("0.147.0").nextTurn, true);
  assert.equal(capabilities("0.147.0").livePush, false,
    "the hook capture says nothing about a daemon nobody had yet");
  assert.equal(capabilities("0.147.0").replyRoute, false);
  assert.equal(capabilities("0.152.0").nextTurn, true,
    "0.152.0 kept the hook that 0.147.0 proved");
  assert.equal(capabilities("0.152.0").livePush, false,
    "its own capture recorded the daemon failing");
  for (const version of ["0.152.1", "0.153.4", "0.160.0", "unknown"]) {
    assert.equal(capabilities(version).nextTurn, true,
      `${version} lost the next-turn hook that no capture withdrew`);
    assert.equal(capabilities(version).livePush, true,
      `${version} lost its captured LocalDaemon capability`);
    assert.equal(capabilities(version).replyRoute, false,
      `${version} gained a reply route the 0.152.0 capture recorded as failing`);
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

test("an uncaptured platform reads what was captured, and no more", () => {
  const delivery = effectiveCapabilities(createCodexAdapter(),
    { clientVersion: "0.152.1", platform: "linux-arm64" }).delivery;

  // Every capture in this repository was taken on darwin-arm64. Gating on the
  // platform left Linux and Windows with no delivery into context at all,
  // which is a machine nobody measured rather than a client that failed.
  assert.equal(delivery.nextTurn, true);
  assert.equal(delivery.livePush, true);
  assert.equal(delivery.replyRoute, false, "an unobserved capability stays unobserved");
});
