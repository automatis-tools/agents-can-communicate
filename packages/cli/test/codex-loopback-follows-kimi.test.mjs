import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareLivePermissions } from "../../adapter-codex/src/live-permissions.mjs";
import { PROTOCOL_CONTRACT } from "../../adapter-kimi/src/web-contract.mjs";
import { recordInstall } from "@agents-can-communicate/installer";

import { clientContext, runInstallCommand } from "../src/install-command.mjs";
import { prepareRefresh } from "../src/managed-runtime/refresh.mjs";
import { writeFakeClient } from "../../../tests/helpers/fake-client.mjs";
import { POSIX_LIVE_TRANSPORT } from "../../../tests/helpers/platform-scope.mjs";

// Review of #400. A Codex domain rule cannot name a port, so 127.0.0.1 in the
// sandboxed sender's profile opens every local service. Kimi Web is the only
// loopback receiver, and the grant exists only while Kimi's live delivery is
// recorded on: off, or no Kimi at all, and Codex keeps the socket-only profile.
const GRANT = /^\[permissions\.acc-workspace\.network\.domains\]\n"127\.0\.0\.1" = "allow"$/m;

test("the loopback declaration follows Kimi's recorded live policy", () => {
  const at = livePolicies => clientContext("/home/dana", "/data/acc",
    { platform: "darwin", env: {}, livePolicies }).receiverLoopback;
  assert.equal(at(undefined), false);
  assert.equal(at({}), false);
  assert.equal(at({ codex: "all", claude_code: "all" }), false);
  assert.equal(at({ kimi: "off" }), false);
  assert.equal(at({ kimi: "actionable" }), true);
  assert.equal(at({ kimi: "all" }), true);
});

async function machine(t, { kimi = true } = {}) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-kimi-loopback-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, "home");
  const dataHome = path.join(base, "data");
  const bin = path.join(base, "bin");
  const codexHome = path.join(home, ".codex");
  await mkdir(bin, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await mkdir(path.join(home, ".kimi-code"), { recursive: true });
  await writeFakeClient(bin, "codex", { output: "codex-cli 0.157.1" });
  if (kimi) await writeFakeClient(bin, "kimi", { output: "kimi, version 2.4.0" });
  const config = path.join(codexHome, "config.toml");
  // An owned Codex profile ACC wrote before any loopback receiver was enabled.
  const written = prepareLivePermissions('model = "mine"\n', { home, codexHome,
    stateRoot: path.join(dataHome, "acc"), file: config, requestedLivePolicy: "actionable",
    clientVersion: "0.157.1", receiverSockets: [] });
  assert.equal(written.status.state, "configured");
  await writeFile(config, written.source);
  await recordInstall({ dataHome, adapterId: "codex", version: "0.157.1", artifacts: [],
    deliveryPolicy: "actionable",
    deliveryDecision: { source: "interactive-accepted", completeSetup: true } });
  const env = { HOME: home, ACC_DATA_HOME: dataHome, ACC_NO_UPDATE_CHECK: "1",
    ACC_PROBE_TIMEOUT_MS: "30000", PATH: `${bin}:/usr/bin:/bin` };
  return { home, dataHome, bin, config, env };
}

test("a managed refresh grants 127.0.0.1 only while Kimi's live delivery is on",
  { skip: POSIX_LIVE_TRANSPORT }, async t => {
    const { home, dataHome, config, env } = await machine(t);
    const refreshWith = async (kimiPolicy, { activated = kimiPolicy !== "off" } = {}) => {
      await recordInstall({ dataHome, adapterId: "kimi", version: "2.4.0", artifacts: [],
        deliveryPolicy: kimiPolicy,
        deliveryDecision: { source: "explicit-option", completeSetup: kimiPolicy !== "off" },
        nativeActivation: activated
          ? { livePolicy: kimiPolicy, protocolContract: PROTOCOL_CONTRACT, mechanisms: [] } : null });
      const control = { home, targets: ["codex"], active: { version: "0.12.2", root: process.cwd() },
        pending: { version: "0.12.3", root: process.cwd() } };
      const refresh = await prepareRefresh({ control, root: path.join(dataHome, "acc", "runtime"),
        callerProtocol: 2, env });
      const result = await refresh();
      assert.deepEqual(result.failed, []);
      return readFile(config, "utf8");
    };

    assert.doesNotMatch(await refreshWith("off"), /127\.0\.0\.1/);
    // Requested but never activated - a Kimi below the Web floor - opens nothing.
    assert.doesNotMatch(await refreshWith("actionable", { activated: false }), /127\.0\.0\.1/);
    const enabled = await refreshWith("actionable");
    assert.match(enabled, GRANT);
    assert.match(enabled, /^model = "mine"$/m);
    // Turned off again: the next refresh drops the grant it no longer needs.
    const disabled = await refreshWith("off");
    assert.doesNotMatch(disabled, /127\.0\.0\.1|network\.domains/);
    assert.match(disabled, /^model = "mine"$/m);
  });

test("turning Kimi's live delivery on or off rewrites an installed Codex profile in the same run",
  { skip: POSIX_LIVE_TRANSPORT }, async t => {
    const { home, bin, config, env } = await machine(t);
    const previous = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previous}`;
    t.after(() => { process.env.PATH = previous; });
    const install = delivery => runInstallCommand({
      options: { home, adapter: "kimi", delivery },
      runtime: { platform: process.platform, env: { ...process.env, ...env } }, action: "install" });

    const on = await install("actionable");
    assert.ok(on.data.plan.operations.some(operation => operation.adapterId === "codex"),
      "Codex joined the run because its receiver set changed");
    assert.match(await readFile(config, "utf8"), GRANT);

    // Unchanged receivers: an install naming Kimi leaves Codex out of the run.
    const again = await install("actionable");
    assert.equal(again.data.plan.operations.some(operation => operation.adapterId === "codex"), false);

    const off = await install("off");
    assert.ok(off.data.plan.operations.some(operation => operation.adapterId === "codex"));
    const source = await readFile(config, "utf8");
    assert.doesNotMatch(source, /127\.0\.0\.1|network\.domains/);
    assert.match(source, /^model = "mine"$/m);
  });

test("a delivery choice for a Kimi that is not on the machine grants Codex nothing",
  { skip: POSIX_LIVE_TRANSPORT }, async t => {
    const { home, bin, config, env } = await machine(t, { kimi: false });
    const previous = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previous}`;
    t.after(() => { process.env.PATH = previous; });
    const before = await readFile(config, "utf8");
    // Every client, one explicit answer: the plan skips the absent Kimi.
    const result = await runInstallCommand({ options: { home, delivery: "actionable" },
      runtime: { platform: process.platform, env: { ...process.env, ...env } }, action: "install" });
    assert.ok(result.data.plan.skipped.some(entry => entry.adapterId === "kimi"));
    const after = await readFile(config, "utf8");
    assert.doesNotMatch(after, /127\.0\.0\.1|network\.domains/);
    assert.match(before, /^model = "mine"$/m);
    assert.match(after, /^model = "mine"$/m);
  });
