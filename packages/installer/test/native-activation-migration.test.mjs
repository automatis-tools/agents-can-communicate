import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { diagnoseAdapters } from "../../cli/src/doctor-command.mjs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyPlan } from "../src/apply.mjs";
import { detectInstallation } from "../src/detect.mjs";
import { applyNativeActivation, planActivationRetirements } from "../src/native-activation.mjs";
import { loadOwnership, recordInstall } from "../src/ownership.mjs";
import { planInstallation } from "../src/plan.mjs";
import { planNativeActivation } from "../../adapter-codex/src/native-delivery.mjs";

const service = { kind: "native-service", serviceId: "codex-app-server", preExisting: true,
  applyCommand: null, teardownCommand: null };
const protocolContract = "codex-app-server-thread-queue-v1";

async function machine(t, { shared = false } = {}) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-migrate-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dataHome = path.join(home, "data");
  const shimDir = path.join(dataHome, "acc", "bin");
  const rcFile = path.join(home, ".zshrc");
  const vendor = path.join(home, "vendor", "codex");
  await mkdir(path.dirname(vendor));
  await writeFile(vendor, "#!/bin/sh\nprintf '%s\\n' 0.152.1\n", { mode: 0o700 });
  await writeFile(rcFile, "# user rc\n");
  const activation = { livePolicy: "actionable", protocolContract, shell: "zsh", rcFile,
    shimDir, mechanisms: [service, { kind: "shell-bootstrap", command: "codex",
      realExecutable: vendor, prefixArgs: ["--remote", "unix://"] }] };
  const runtime = { node: process.execPath, bootstrap: "/tmp/unused-bootstrap.mjs" };
  const applied = await applyNativeActivation({ adapter: { id: "codex" }, activation, dataHome, ...runtime });
  await recordInstall({ dataHome, adapterId: "codex", version: "0.152.1", accVersion: "0.3.0",
    artifacts: [], nativeActivation: applied.nativeActivation });
  if (shared) await applyNativeActivation({ adapter: { id: "claude_code" }, dataHome, ...runtime,
    activation: { ...activation, mechanisms: [{ kind: "shell-bootstrap", command: "claude",
      realExecutable: vendor, prefixArgs: [] }] } });
  const context = { home, dataHome, stateRoot: path.join(dataHome, "acc"), shell: "bash",
    env: { PATH: path.dirname(vendor), CODEX_HOME: path.join(home, "custom-codex") } };
  const adapter = { id: "codex", displayName: "Fixture Codex migration", planInstall: () => [],
    install: async () => ({ changes: [] }), uninstall: async () => ({ changes: [] }) };
  const detected = [{ adapterId: "codex", present: true, version: "0.152.1", installed: true,
    nativeDelivery: { state: "eligible", eligibility: { protocolContract },
      activationPlan: { eligible: true, reasonCode: null, mechanisms: [service] } } }];
  const plan = async (policy = "actionable", action = "install") => planInstallation({
    adapters: [adapter], detected, context, action, recorded: (await loadOwnership({ dataHome })).installs,
    deliveryByAdapter: { codex: policy } });
  const apply = async (options = {}) => applyPlan({ plan: await plan(), adapters: [adapter], context,
    dataHome, activation: { ...runtime, exec: async () => { throw new Error("service command forbidden"); } }, ...options });
  return { home, dataHome, shimDir, rcFile, vendor, context, adapter, plan, apply,
    shim: path.join(shimDir, "codex") };
}

test("Codex activation reuses only the pre-existing service without rewriting launch", () => {
  assert.deepEqual(planNativeActivation({ detection: { realExecutable: "/vendor/codex" } }),
    { eligible: true, reasonCode: null, mechanisms: [service] });
});

test("enabled-to-enabled migration retires only the Codex wrapper, preserving shared PATH", async t => {
  const h = await machine(t, { shared: true });
  const before = await readFile(h.rcFile, "utf8");
  const plan = await h.plan();
  assert.deepEqual(plan.operations[0].deactivation?.mechanisms.map(item => item.kind), ["shell-bootstrap"]);
  await h.apply({ plan, dryRun: true });
  assert.ok(await stat(h.shim));
  const result = await h.apply({ plan });
  assert.deepEqual(result.failed, []);
  await assert.rejects(stat(h.shim), { code: "ENOENT" });
  assert.ok(await stat(path.join(h.shimDir, "claude")));
  assert.equal(await readFile(h.rcFile, "utf8"), before);
  assert.deepEqual((await h.apply()).failed, []);
  const record = (await loadOwnership(h)).installs[0];
  assert.deepEqual(record.nativeActivation.mechanisms.map(item => item.kind), ["native-service"]);
});

test("a modified legacy shim retains bytes and cleanup authority across install, off and uninstall", async t => {
  const h = await machine(t);
  const original = await readFile(h.shim, "utf8");
  const modified = original + "# user edit\n";
  await writeFile(h.shim, modified);
  const originalHash = (await loadOwnership(h)).installs[0].nativeActivation.mechanisms
    .find(item => item.kind === "shell-bootstrap").ownedFiles[0].sha256;
  for (const [policy, action] of [["actionable", "install"], ["actionable", "install"],
    ["off", "install"], ["off", "uninstall"]]) {
    const result = await h.apply({ plan: await h.plan(policy, action) });
    assert.deepEqual(result.failed, []);
    assert.equal(await readFile(h.shim, "utf8").catch(() => null), modified);
    assert.match(result.operations[0].diagnostics.join("\n"), /kept shim/);
    const record = (await loadOwnership(h)).installs[0];
    assert.equal(record.deliveryPolicy, action === "uninstall" ? "off" : policy);
    const kept = record.nativeActivation.mechanisms.find(item => item.kind === "shell-bootstrap");
    assert.equal(kept.ownedFiles[0].sha256, originalHash, "do not bless changed bytes as ACC-owned");
  }
  await writeFile(h.shim, original);
  assert.deepEqual((await h.apply({ plan: await h.plan("off", "uninstall") })).failed, []);
  await assert.rejects(stat(h.shim), { code: "ENOENT" });
  assert.deepEqual((await loadOwnership(h)).installs, []);
});

test("failure after teardown retains old recipe and a rerun converges", async t => {
  const h = await machine(t);
  const plan = await h.plan();
  plan.operations[0].nativeActivation.mechanisms = [{ ...service, preExisting: false,
    applyCommand: { executable: "/forbidden/start", args: [] } }];
  const failed = await h.apply({ plan });
  assert.equal(failed.failed.length, 1);
  await assert.rejects(stat(h.shim), { code: "ENOENT" });
  assert.ok((await loadOwnership(h)).installs[0].nativeActivation.mechanisms
    .some(item => item.kind === "shell-bootstrap"));
  assert.deepEqual((await h.apply()).failed, []);
  assert.deepEqual((await loadOwnership(h)).installs[0].nativeActivation.mechanisms
    .map(item => item.kind), ["native-service"]);
});

test("service-only detection accepts a non-zsh shell and explicitly uses installation env", async t => {
  const h = await machine(t);
  let received;
  const adapter = { ...h.adapter, client: { command: "codex" }, detect: async () => ({ ok: true }),
    nativeDelivery: { minimumByPlatform: { "darwin-arm64": "0.152.1" },
      anchors: [{ platform: "darwin-arm64", version: "0.152.1", protocolContract }],
      knownBad: [], activationKinds: ["native-service"] },
    probeNativeDelivery: async input => { received = input.env; return { supported: true,
      clientVersion: "0.152.1", protocolContract, executableFingerprint: null,
      modes: ["livePush"], reasonCode: null }; }, planNativeActivation };
  const [entry] = await detectInstallation({ adapters: [adapter], context: h.context,
    probe: async () => "codex-cli 0.152.1", platform: "darwin-arm64" });
  assert.equal(entry.nativeDelivery.state, "eligible");
  assert.equal(received, h.context.env);
});


test("after migration ordinary argv reaches the vendor byte-for-byte", async t => {
  const h = await machine(t);
  assert.deepEqual((await h.apply()).failed, []);
  await writeFile(h.vendor, `#!/bin/sh\nfor arg in "$@"; do printf '%s\\0' "$arg"; done\n`);
  for (const args of [["--cd", "/absolute with spaces", "a'b", "$HOME"],
    ["--cd", "relative dir", "resume", "thread-id"], ["fork", "thread-id"],
    ["-c", "model_reasoning_effort=low", "", "`literal`"]]) {
    const result = spawnSync("/bin/sh", ["-c", 'exec codex "$@"', "codex", ...args],
      { env: { PATH: `${h.shimDir}:${path.dirname(h.vendor)}:/bin:/usr/bin` } });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.toString(), args.map(arg => `${arg}\0`).join(""));
  }
});

test("doctor exposes a retained modified native shim from ownership", async t => {
  const h = await machine(t);
  await writeFile(h.shim, await readFile(h.shim, "utf8") + "# user edit\n");
  assert.deepEqual((await h.apply()).failed, []);
  const [report] = await diagnoseAdapters({ options: { home: h.home },
    runtime: { env: { HOME: h.home, ACC_DATA_HOME: h.dataHome }, platform: process.platform },
    detect: async () => [{ adapterId: "codex", present: true, installed: true }] });
  assert.ok(report.owned.modified.includes(h.shim));
});


test("shell retirement compares command identity and refuses an empty legacy identity", () => {
  const desired = { mechanisms: [{ kind: "shell-bootstrap", command: "claude" }] };
  const shell = command => ({ kind: "shell-bootstrap", command, ownedFiles: [] });
  for (const old of [shell("codex"), { kind: "shell-bootstrap", ownedFiles: [] },
    { kind: "shell-bootstrap", ownedFiles: [{ path: "/old/bin/codex" }] }]) {
    assert.deepEqual(planActivationRetirements({ previous: { mechanisms: [old] }, desired }), [old]);
  }
  for (const old of [shell("claude"),
    { kind: "shell-bootstrap", ownedFiles: [{ path: "/old/bin/claude" }] }]) {
    assert.deepEqual(planActivationRetirements({ previous: { mechanisms: [old] }, desired }), []);
  }
});
