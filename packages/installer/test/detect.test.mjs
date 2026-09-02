import assert from "node:assert/strict";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { detectInstallation } from "../src/detect.mjs";

// Adapters reduced to what detection uses. The real ones are exercised in the
// install tests; here the point is the detection rules themselves.
const adapter = (id, overrides = {}) => ({
  id,
  displayName: id,
  client: { command: id, certificationName: id, versionArgs: ["--version"] },
  capabilities: { guards: { beforeWrite: true }, lifecycle: { sessionEnd: true } },
  certification: { evidence: [{ client: id, version: "0.147.0",
    platform: "darwin-arm64", capability: "guards.beforeWrite", result: "pass" }] },
  detect: async () => ({ ok: true, changes: [],
    diagnostics: ["acc plugin not registered"] }),
  ...overrides,
});

const probeFor = table => async command => table[command] ?? null;

async function home(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "acc-detect-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("a workspace with no clients installed reports every one as absent", async t => {
  const context = { home: await home(t), dataHome: await home(t) };

  const detected = await detectInstallation({
    adapters: [adapter("codex"), adapter("kimi")],
    probe: probeFor({}), context });

  assert.deepEqual(detected.map(entry => entry.present), [false, false]);
  assert.deepEqual(detected.map(entry => entry.version), [null, null]);
});

test("a present client reports the version it printed", async t => {
  const context = { home: await home(t), dataHome: await home(t) };

  const detected = await detectInstallation({
    adapters: [adapter("codex"), adapter("kimi")],
    probe: probeFor({ codex: "codex-cli 0.147.0" }), context });

  const codex = detected.find(entry => entry.adapterId === "codex");
  assert.equal(codex.present, true);
  assert.equal(codex.version, "0.147.0");
  assert.equal(detected.find(entry => entry.adapterId === "kimi").present, false);
});

test("detection advertises only capabilities effective for the observed version and platform",
  async t => {
    const context = { home: await home(t), dataHome: await home(t) };
    const exact = await detectInstallation({ adapters: [adapter("codex")],
      probe: probeFor({ codex: "codex-cli 0.147.0" }), context,
      platform: "darwin-arm64" });
    const mismatch = await detectInstallation({ adapters: [adapter("codex")],
      probe: probeFor({ codex: "codex-cli 0.148.0" }), context,
      platform: "darwin-arm64" });
    const unknown = await detectInstallation({ adapters: [adapter("codex")],
      probe: probeFor({ codex: "build from source" }), context,
      platform: "darwin-arm64" });

    assert.equal(exact[0].capabilities.guards.beforeWrite, true);
    assert.equal(mismatch[0].capabilities.guards.beforeWrite, false);
    assert.equal(unknown[0].capabilities.guards.beforeWrite, false);
  });

test("a version that cannot be parsed is reported raw, not dropped", async t => {
  const context = { home: await home(t), dataHome: await home(t) };

  const detected = await detectInstallation({ adapters: [adapter("codex")],
    probe: probeFor({ codex: "a build from source" }), context });

  // Present with an unreadable version is a real state, and one worth showing:
  // pretending the client is absent would hide it from every later step.
  assert.equal(detected[0].present, true);
  assert.equal(detected[0].version, null);
  assert.equal(detected[0].versionOutput, "a build from source");
});

test("a conventional v-prefixed version is still an exact observed version", async t => {
  const context = { home: await home(t), dataHome: await home(t) };
  const detected = await detectInstallation({ adapters: [adapter("codex")],
    probe: probeFor({ codex: "v0.147.0" }), context });

  assert.equal(detected[0].version, "0.147.0");
});

test("detection asks the adapter whether ACC is already installed", async t => {
  const context = { home: await home(t), dataHome: await home(t) };
  const installed = adapter("codex", { detect: async () => ({ ok: true, changes: [],
    diagnostics: ["acc plugin published in the marketplace",
      "plugin installed in the client's cache"] }) });

  const detected = await detectInstallation({ adapters: [installed],
    probe: probeFor({ codex: "codex-cli 0.147.0" }), context });

  assert.equal(detected[0].installed, true);
  assert.deepEqual(detected[0].diagnostics.length > 0, true);
});

test("a fallback diagnostic does not mutate adapter-owned detection results", async t => {
  const context = { home: await home(t), dataHome: await home(t) };
  const adapterDiagnostics = Object.freeze(["acc plugin not registered"]);
  const durable = adapter("claude_code", {
    deliveryFallback: { diagnostic: "native capture failed; use inbox" },
    detect: async () => ({ ok: true, changes: [], diagnostics: adapterDiagnostics }),
  });

  const [detected] = await detectInstallation({ adapters: [durable],
    probe: probeFor({ claude_code: "0.147.0" }), context });

  assert.deepEqual(detected.diagnostics,
    ["acc plugin not registered", "native capture failed; use inbox"]);
  assert.deepEqual(adapterDiagnostics, ["acc plugin not registered"]);
});

test("an uncertified next-turn version is named as an inbox downgrade", async t => {
  const context = { home: await home(t), dataHome: await home(t) };
  const nextTurn = adapter("gemini_cli", {
    capabilities: { delivery: { nextTurn: true } },
    certification: { evidence: [{ client: "gemini_cli", version: "0.37.0",
      platform: "darwin-arm64", capability: "delivery.nextTurn", result: "pass" }] },
    deliveryFallback: { diagnostic: "live delivery unavailable; acc inbox remains active" },
  });

  const [detected] = await detectInstallation({ adapters: [nextTurn],
    probe: probeFor({ gemini_cli: "0.55.1" }), context, platform: "darwin-arm64" });

  assert.equal(detected.capabilities.delivery.nextTurn, false);
  assert.match(detected.deliveryDiagnostic, /0\.55\.1/);
  assert.match(detected.deliveryDiagnostic, /next-turn/);
  assert.match(detected.deliveryDiagnostic, /acc inbox/);
});

test("detection writes nothing at all", async t => {
  const dir = await home(t);
  const context = { home: dir, dataHome: dir };

  await detectInstallation({ adapters: [adapter("codex"), adapter("kimi")],
    probe: probeFor({ codex: "codex-cli 0.147.0" }), context });

  // A command someone runs to find out what is going on must not change it.
  assert.deepEqual(await readdir(dir), []);
});

test("an adapter whose detect throws is reported, not allowed to end the run", async t => {
  const context = { home: await home(t), dataHome: await home(t) };
  const broken = adapter("kimi", {
    detect: async () => { throw new Error("config is unreadable"); } });

  const detected = await detectInstallation({
    adapters: [adapter("codex"), broken],
    probe: probeFor({ codex: "codex-cli 0.147.0", kimi: "0.36.1" }), context });

  // One unreadable client must not hide the other three. The failure is part of
  // the report rather than the end of it.
  assert.equal(detected.length, 2);
  const kimi = detected.find(entry => entry.adapterId === "kimi");
  assert.equal(kimi.installed, false);
  assert.match(kimi.error, /config is unreadable/);
});

test("a probe that hangs cannot hold up detection forever", async t => {
  const context = { home: await home(t), dataHome: await home(t) };
  const never = () => new Promise(() => {});

  const detected = await detectInstallation({ adapters: [adapter("codex")],
    probe: never, context, probeTimeoutMs: 20 });

  assert.equal(detected[0].present, false);
  assert.match(detected[0].error ?? "", /timed out/);
});

test("the report is ordered by adapter id, so two runs can be compared", async t => {
  const context = { home: await home(t), dataHome: await home(t) };

  const detected = await detectInstallation({
    adapters: [adapter("kimi"), adapter("codex"), adapter("claude_code")],
    probe: probeFor({}), context });

  assert.deepEqual(detected.map(entry => entry.adapterId),
    ["claude_code", "codex", "kimi"]);
});
