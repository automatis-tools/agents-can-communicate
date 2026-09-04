import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile }
  from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { defineAdapter } from "@agents-can-communicate/adapter-sdk";

import { FAILED_TTL_MS, SUPPORTED_TTL_MS, cachePathFor, checkNativeBootstrap }
  from "../src/bootstrap-runtime.mjs";

const NOW = "2026-09-02T12:00:00.000Z";
const noop = async () => ({ ok: true, changes: [], diagnostics: [] });
const PROBE = { supported: true, clientVersion: "2.1.258", protocolContract: "fixture-native-v1",
  executableFingerprint: null, modes: ["livePush", "idleWake"], reasonCode: null };

function adapterWith(probe = async () => PROBE) {
  return defineAdapter({
    id: "fixture", displayName: "Fixture",
    client: { command: "fixture", certificationName: "fixture-client", versionArgs: ["--version"] },
    capabilities: { delivery: { livePush: true } },
    certification: { evidence: [{ client: "fixture-client", version: "2.1.258",
      platform: "darwin-arm64", observedAt: NOW, capability: "delivery.livePush",
      fixture: "fixtures/delivery/fixture-client-2.1.258.json",
      provenance: "fixtures/certification-provenance.json", provenanceId: "native",
      idleBehavior: "offered", busyBehavior: "queued_after_turn", authorityLevel: "experimental",
      limitations: ["fixture only"], result: "pass" }] },
    nativeDelivery: { minimumByPlatform: { "darwin-arm64": "2.1.258" },
      anchors: [{ platform: "darwin-arm64", version: "2.1.258", protocolContract: "fixture-native-v1" }],
      knownBad: [{ version: "2.1.300", reasonCode: "known_bad_version" }],
      activationKinds: ["shell-bootstrap"] },
    detect: noop, install: noop, uninstall: noop, doctor: noop,
    normalizeHook: () => ({ kind: "sessionStart", sessionId: "s", cwd: "/tmp" }),
    renderContext: () => "",
    offerMessage: async () => ({ accepted: true, transport: "fixture", clientVersion: "2.1.258" }),
    probeNativeDelivery: probe,
    planNativeActivation: async () => ({ eligible: false, reasonCode: "unsupported_shell",
      mechanisms: [] }),
    bindNativeSession: async () => null,
  });
}

async function place(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-bootstrap-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "vendor-2.1.258");
  await writeFile(executable, "#!/bin/sh\necho 2.1.258\n", { mode: 0o700 });
  const link = path.join(root, "vendor");
  await symlink(executable, link);
  const dataHome = path.join(root, "data");
  return { root, executable, link, dataHome };
}

function harness({ version = "2.1.258", probe } = {}) {
  const calls = { version: 0, probe: 0 };
  let now = Date.parse(NOW);
  const adapter = adapterWith(async () => { calls.probe += 1; return probe ? probe() : PROBE; });
  const check = (options = {}) => checkNativeBootstrap({ adapter, platform: "darwin-arm64",
    timeoutMs: 100, clock: { now: () => new Date(now).toISOString() },
    readVersion: async () => { calls.version += 1; return version; }, ...options });
  return { adapter, calls, check, advance: ms => { now += ms; } };
}

test("the minimum plus a matching probe is supported, and so is a newer stable client",
  async t => {
    const here = await place(t);
    const h = harness();
    assert.deepEqual(await h.check({ realExecutable: here.link, dataHome: here.dataHome }),
      { supported: true, reasonCode: null });
    const newer = harness({ version: "2.4.0",
      probe: () => ({ ...PROBE, clientVersion: "2.4.0" }) });
    assert.deepEqual(await newer.check({ realExecutable: here.link, dataHome: here.dataHome }),
      { supported: true, reasonCode: null });
  });

test("old, prerelease, known-bad, wrong-protocol, timed-out, throwing, and malformed probes fail closed",
  async t => {
    const here = await place(t);
    const cases = [
      [{ version: "2.1.100" }, "below_minimum_version"],
      [{ version: "2.2.0-beta.1" }, "prerelease_not_captured"],
      [{ version: "2.1.300", probe: () => ({ ...PROBE, clientVersion: "2.1.300" }) },
        "known_bad_version"],
      [{ probe: () => ({ ...PROBE, protocolContract: "fixture-native-v2" }) }, "protocol_mismatch"],
      [{ probe: () => new Promise(() => {}) }, "probe_timeout"],
      [{ probe: () => { throw new Error("socket /secret refused"); } }, "feature_probe_failed"],
      [{ probe: () => ({ ...PROBE, transcript: "leak" }) }, "feature_probe_failed"],
      [{ version: null }, "version_unavailable"],
    ];
    for (const [options, reasonCode] of cases) {
      const dataHome = path.join(here.root, `data-${reasonCode}`);
      const h = harness(options);
      const result = await h.check({ realExecutable: here.link, dataHome });
      assert.deepEqual(result, { supported: false, reasonCode }, reasonCode);
    }
    const nothing = await checkNativeBootstrap({ adapter: { id: "plain" },
      realExecutable: here.link, platform: "darwin-arm64", dataHome: here.dataHome });
    assert.deepEqual(nothing, { supported: false, reasonCode: "native_delivery_unsupported" });
    const missing = harness();
    assert.deepEqual(await missing.check({ realExecutable: path.join(here.root, "absent"),
      dataHome: here.dataHome }), { supported: false, reasonCode: "feature_probe_failed" });
  });

test("an unchanged executable reuses the cache without spawning again", async t => {
  const here = await place(t);
  const h = harness();
  await h.check({ realExecutable: here.link, dataHome: here.dataHome });
  await h.check({ realExecutable: here.link, dataHome: here.dataHome });
  assert.deepEqual(h.calls, { version: 1, probe: 1 });
  const file = cachePathFor(here.dataHome, "fixture");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const record = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(Object.keys(record.identity).sort(),
    ["executableFingerprint", "inode", "mtimeMs", "path", "size", "target"]);
  assert.equal(record.identity.target, here.executable);
  assert.match(record.identity.executableFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(record.clientVersion, "2.1.258");
  assert.equal(JSON.stringify(record).includes("echo 2.1.258"), false);
  h.advance(SUPPORTED_TTL_MS + 1);
  await h.check({ realExecutable: here.link, dataHome: here.dataHome });
  assert.deepEqual(h.calls, { version: 2, probe: 2 });
});

test("replacing or upgrading the executable invalidates the cache", async t => {
  const here = await place(t);
  const h = harness();
  await h.check({ realExecutable: here.link, dataHome: here.dataHome });
  await writeFile(here.executable, "#!/bin/sh\necho 2.1.259\n", { mode: 0o700 });
  await h.check({ realExecutable: here.link, dataHome: here.dataHome });
  assert.deepEqual(h.calls, { version: 2, probe: 2 });
  // Same bytes, new mtime: still a miss, because the key is the identity.
  await utimes(here.executable, new Date(0), new Date(1_700_000_000_000));
  await h.check({ realExecutable: here.link, dataHome: here.dataHome });
  assert.deepEqual(h.calls, { version: 3, probe: 3 });
});

test("a cached failure expires quickly so a repaired client comes back", async t => {
  const here = await place(t);
  let broken = true;
  const h = harness({ probe: () => { if (broken) throw new Error("down"); return PROBE; } });
  assert.deepEqual(await h.check({ realExecutable: here.link, dataHome: here.dataHome }),
    { supported: false, reasonCode: "feature_probe_failed" });
  broken = false;
  assert.equal((await h.check({ realExecutable: here.link, dataHome: here.dataHome })).supported,
    false, "the failure is cached for a short while");
  h.advance(FAILED_TTL_MS + 1);
  assert.deepEqual(await h.check({ realExecutable: here.link, dataHome: here.dataHome }),
    { supported: true, reasonCode: null });
});
