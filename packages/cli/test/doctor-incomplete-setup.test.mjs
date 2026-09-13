import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { diagnoseAdapters } from "../src/doctor-command.mjs";

async function diagnosed(t, deliveryDecision) {
  const home = await mkdtemp(path.join(tmpdir(), "acc-doctor-incomplete-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dataHome = path.join(home, "data");
  const record = path.join(dataHome, "acc", "installs.json");
  await mkdir(path.dirname(record), { recursive: true });
  const installs = deliveryDecision === false ? [] : [{
    adapterId: "codex", version: "0.154.0", artifacts: [], deliveryPolicy: "off",
    ...(deliveryDecision === undefined ? {} : { deliveryDecision }),
  }];
  await writeFile(record, `${JSON.stringify({ schemaVersion: 1, installs }, null, 2)}\n`);
  const permissionDiagnostic = "outgoing live delivery: sender permissions unverified in config; "
    + "ACC outgoing grants are absent";
  const [entry] = await diagnoseAdapters({ options: { home }, runtime: {
    platform: "darwin", env: { HOME: home, ACC_DATA_HOME: dataHome },
  }, detect: async () => [{
    adapterId: "codex", displayName: "Codex CLI", present: true,
    installed: deliveryDecision !== false,
    version: "0.154.0", platform: "darwin-arm64", artifacts: [],
    nativeDelivery: { state: "eligible", reasonCode: "native_endpoint_unavailable",
      consentAvailable: true },
    nativeServiceSetup: { state: "needed", reasonCode: "native_endpoint_unavailable",
      diagnostic: "ACC can prepare the missing supported Codex service" },
    outgoingDelivery: { state: "unverified", reasonCode: "sender_permissions_unverified",
      diagnostic: permissionDiagnostic },
    needsAction: [permissionDiagnostic],
  }] });
  return entry;
}

test("doctor reports a known declined off decision and each outgoing remediation once", async t => {
  const entry = await diagnosed(t,
    { source: "interactive-declined", completeSetup: false });

  assert.deepEqual(entry.deliveryDecision,
    { source: "interactive-declined", completeSetup: false });
  assert.equal(entry.remediation.filter(line => /sender permissions unverified/.test(line)).length, 1);
});

test("doctor keeps legacy off provenance explicitly unknown", async t => {
  const entry = await diagnosed(t, undefined);
  assert.deepEqual(entry.deliveryDecision,
    { source: "legacy-unknown", completeSetup: false });
});

test("doctor does not invent decision provenance before an install", async t => {
  const entry = await diagnosed(t, false);
  assert.equal(entry.deliveryDecision, null);
});
