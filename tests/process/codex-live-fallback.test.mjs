import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile }
  from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import * as codexModule from "@agents-can-communicate/adapter-codex";
import { loadOwnership } from "@agents-can-communicate/installer";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const acc = path.join(repo, "bin", "acc.mjs");
const capturedPlatform = `${process.platform}-${process.arch}` === "darwin-arm64";
const shellLiteral = value => `'${String(value).replaceAll("'", "'\"'\"'")}'`;

// This is a fake executable, not a fake LocalDaemon. The disposable CODEX_HOME
// has no socket, which exercises the unavailable-receiver fallback without
// starting or modifying a vendor process.
async function machine(t, version = "codex-cli 0.152.1") {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-codex-home-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-codex-data-")));
  const codexHome = path.join(home, ".codex");
  const project = path.join(home, "project");
  const bin = path.join(home, "bin");
  const argvLog = path.join(home, "fake-codex-argv.log");
  await mkdir(codexHome, { recursive: true });
  await mkdir(project);
  await mkdir(bin);
  await writeFile(path.join(codexHome, "config.toml"), 'model = "gpt-5"\n');
  const codex = path.join(bin, "codex");
  await writeFile(codex, `#!/bin/sh
printf '%s|%s|%s\\n' "$CODEX_HOME" "$#" "$*" >> ${shellLiteral(argvLog)}
printf '%s\\n' ${shellLiteral(version)}
`);
  await chmod(codex, 0o755);
  t.after(() => Promise.all([home, dataHome]
    .map(directory => rm(directory, { recursive: true, force: true }))));

  // Keep the child free of ambient ACC/Codex/Node state. The absolute Node
  // executable runs ACC; PATH only resolves this disposable fake plus sh tools.
  const env = { PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter), HOME: home,
    CODEX_HOME: codexHome, ACC_DATA_HOME: dataHome, ACC_NO_UPDATE_CHECK: "1",
    ACC_PROBE_TIMEOUT_MS: "30000", GIT_DIR: "", GIT_WORK_TREE: "" };
  const command = (...args) => run(process.execPath, [acc, ...args, "--cwd", project], { env });
  const argv = async () => (await readFile(argvLog, "utf8")).trimEnd().split("\n")
    .filter(Boolean).map(line => {
      const [observedHome, argc, args] = line.split("|");
      return { home: observedHome, argc: Number(argc), args };
    });
  const pluginTrees = async () => {
    const source = path.join(home, ".agents", "acc-local", "plugins",
      "agents-can-communicate");
    const versions = await readdir(path.join(home, ".codex", "plugins", "cache",
      "acc-local", "agents-can-communicate"));
    assert.equal(versions.length, 1);
    return [source, path.join(home, ".codex", "plugins", "cache", "acc-local",
      "agents-can-communicate", versions[0])];
  };
  return { argv, codexHome, command, dataHome, home, pluginTrees };
}

async function assertOnlyVersionProbes(place) {
  const calls = await place.argv();
  assert.ok(calls.length > 0, "ACC never probed the fake Codex executable");
  assert.deepEqual(calls, calls.map(() => ({ home: place.codexHome, argc: 1, args: "--version" })),
    "ACC must not start a daemon or pass any non-version argument to Codex");
}

// Removing the descriptor or falsely adding a native reply route makes this
// fail. The hooks remain ordinary hooks; native delivery is bound per session.
test("the public Codex adapter declares LocalDaemon delivery without native replies", () => {
  const adapter = codexModule.createCodexAdapter();
  assert.equal(adapter.capabilities.delivery.livePush, true);
  assert.equal(adapter.capabilities.delivery.replyRoute, false);
  assert.deepEqual(adapter.nativeDelivery.minimumByPlatform, { "darwin-arm64": "0.152.1" });
  assert.deepEqual(adapter.nativeDelivery.anchors, [{ platform: "darwin-arm64", version: "0.152.1",
    protocolContract: "codex-app-server-thread-queue-v1" }]);
  assert.equal(adapter.nativeDelivery.policySource, "installation-record");
  for (const method of ["probeNativeDelivery", "planNativeActivation", "bindNativeSession",
    "refreshNativeSession", "retireNativeSession", "offerMessage"]) {
    assert.equal(typeof adapter[method], "function", method);
  }
  assert.equal(Object.hasOwn(adapter, "routeReply"), false);
});

for (const policy of ["actionable", "all"]) {
  test(`Codex ${policy} consent is recorded while an absent socket stays on fallback`, async t => {
    const place = await machine(t);
    const preview = JSON.parse((await place.command("install", "--adapter", "codex",
      "--delivery", policy, "--home", place.home, "--dry-run", "--json")).stdout).data;
    const [operation] = preview.plan.operations;

    assert.equal(operation.livePolicy, policy);
    assert.equal(operation.effectiveLivePolicy, "off");
    assert.match(operation.deliveryDiagnostic, capturedPlatform
      ? /local delivery service is unavailable/ : /not verified on this platform/);
    assert.match(operation.deliveryDiagnostic, /fallback: acc inbox/);

    const installed = await place.command("install", "--adapter", "codex",
      "--delivery", policy, "--home", place.home);
    assert.match(installed.stdout, /consent saved.*not active/i,
      "the human install report hid the native-delivery downgrade");
    const [record] = (await loadOwnership({ dataHome: place.dataHome })).installs;
    assert.equal(record.deliveryPolicy, policy,
      "an unavailable LocalDaemon discarded the operator's recorded consent");
    assert.equal(record.nativeActivation, undefined,
      "an absent socket created a native activation record");
    await assertOnlyVersionProbes(place);
    await assert.rejects(stat(path.join(place.home, ".codex", "app-server-control")),
      { code: "ENOENT" });
    for (const tree of await place.pluginTrees()) {
      const hooks = await readFile(path.join(tree, "hooks.json"), "utf8");
      assert.match(hooks, /UserPromptSubmit/, "install removed the certified next-turn hook");
      assert.doesNotMatch(hooks,
        /\s--(?:remote|cd)\b/,
        "the installed hook rewrote Codex launch arguments");
    }
  });
}

test("doctor names unavailable fallback without withdrawing captured live delivery", async t => {
  const place = await machine(t);
  await place.command("install", "--adapter", "codex", "--home", place.home);

  const human = (await place.command("doctor", "--home", place.home)).stdout;
  assert.match(human, /Codex CLI live delivery:.*off/);
  assert.match(human, /fallback: acc inbox/);
  if (capturedPlatform) {
    assert.match(human, /local delivery service is unavailable/);
    assert.match(human, /acc install --adapter codex --delivery actionable/);
    assert.match(human, /codex app-server daemon start/);
    assert.match(human, /ACC never starts or restarts the daemon/);
  }
  await assertOnlyVersionProbes(place);

  const body = JSON.parse((await place.command("doctor", "--home", place.home,
    "--json")).stdout).data;
  const codex = body.adapters.find(adapter => adapter.adapterId === "codex");
  assert.equal(codex.capabilities.delivery.nextTurn, false);
  assert.equal(codex.capabilities.delivery.livePush, capturedPlatform);
  assert.equal(codex.capabilities.delivery.replyRoute, false);
  assert.match(codex.deliveryDiagnostic, /fallback: acc inbox/);
  assert.equal(codex.nativeDelivery.reasonCode, capturedPlatform
    ? "native_endpoint_unavailable" : "platform_not_captured");
  await assertOnlyVersionProbes(place);
});

test("an unknown Codex version retains only the durable inbox", async t => {
  const place = await machine(t, "codex-cli development build");
  const body = JSON.parse((await place.command("doctor", "--home", place.home,
    "--json")).stdout).data;
  const codex = body.adapters.find(adapter => adapter.adapterId === "codex");

  assert.equal(codex.version, null);
  assert.equal(codex.capabilities.delivery.nextTurn, false);
  assert.equal(codex.capabilities.delivery.livePush, false);
  assert.equal(codex.capabilities.delivery.replyRoute, false);
  assert.match(codex.deliveryDiagnostic, /acc inbox/);
  await assertOnlyVersionProbes(place);
});
