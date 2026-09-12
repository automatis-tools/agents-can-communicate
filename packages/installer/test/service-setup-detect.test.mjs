import assert from "node:assert/strict";
import test from "node:test";
import { detectInstallation } from "../src/detect.mjs";

function adapter(id, inspect) {
  return { id, displayName: id, client: { command: "absent-fixture-command" }, capabilities: {},
    inspectNativeServiceSetup: inspect, detect: async () => ({ diagnostics: ["installed"] }) };
}

test("service inspection is independent of native eligibility and read-only", async () => {
  let received;
  const result = await detectInstallation({ adapters: [adapter("setup", async context => {
    received = context;
    return { state: "needed", reasonCode: "native_endpoint_unavailable", diagnostic: "Prepare service" };
  })], context: { home: "/private/fixture", env: { PATH: "" } }, platform: "fixture-platform", probe: async () => "1.0.0" });
  assert.equal(result[0].nativeDelivery.state, "unsupported");
  assert.equal(result[0].nativeServiceSetup?.state, "needed");
  assert.equal(received.platform, "fixture-platform");
});

for (const mode of ["throw", "timeout"]) test(`${mode} service probe is blocked without hiding another adapter`, async () => {
  const result = await detectInstallation({ adapters: [adapter("broken", () => {
    if (mode === "throw") throw new Error("private error");
    return new Promise(() => {});
  }), adapter("healthy", async () => ({ state: "ready", reasonCode: null, diagnostic: "Ready" }))],
  context: { env: { PATH: "" } }, probe: async () => "1.0.0", probeTimeoutMs: 10 });
  assert.equal(result[0].nativeServiceSetup?.state, "blocked");
  assert.doesNotMatch(result[0].nativeServiceSetup.diagnostic, /private error/);
  assert.equal(result[1].nativeServiceSetup.state, "ready");
  assert.equal(result[1].installed, true);
});
