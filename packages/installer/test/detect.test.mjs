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
  client: { command: id, versionArgs: ["--version"] },
  capabilities: { guards: { beforeWrite: true }, lifecycle: { sessionEnd: true } },
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
