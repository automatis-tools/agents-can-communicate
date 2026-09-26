import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createPackedAcc, treeSnapshot } from "../helpers/packed-acc.mjs";
import { createUpdateRegistry } from "../helpers/update-registry.mjs";
import { writeLegacyShellActivation } from "../helpers/legacy-shell-bootstrap.mjs";

const captured = process.platform === "darwin" && process.arch === "arm64";
const ownership = f => readFile(path.join(f.dataHome, "acc", "installs.json"), "utf8").then(JSON.parse);
const updateEnv = (f, registry) => ({ ...f.env, ACC_NO_UPDATE_CHECK: "0",
  npm_config_registry: registry.url, npm_config_cache: path.join(f.root, "update-cache") });

// The refresh's native eligibility gate stranded a real opted-in Codex installation
// without a service, and policies recorded for inbox-only adapters stranded it too.
test("packed update retains delivery consent while native services and capabilities are unavailable", async t => {
  const f = await createPackedAcc(t);
  f.env.CODEX_HOME = path.join(f.clientHome, ".codex");
  f.env.SHELL = "/bin/zsh";
  await f.setClientVersions({ codex: "0.154.0", gemini: "0.59.0", grok: "1.0.25" });
  const installed = await f.acc(["install", "--adapter", "codex", "--adapter", "gemini_cli",
    "--adapter", "grok", "--delivery", "actionable"]);
  assert.deepEqual(installed.failed, []);
  await f.acc(["update", "--auto", "off"]);
  const registry = await createUpdateRegistry(t, f);
  const updated = await f.acc(["update"], updateEnv(f, registry));
  assert.equal(updated.activated, true);
  assert.equal((await f.acc(["version"])).version, registry.version);
  const doctor = await f.acc(["doctor"]);
  assert.equal(doctor.update.auto, false, "an update must keep the user's explicit opt-out");
  for (const id of ["codex", "gemini_cli", "grok"]) {
    const adapter = doctor.adapters.find(item => item.adapterId === id);
    assert.equal(adapter.bundleVersion, registry.version);
    assert.equal(adapter.nativeDelivery.policy, "actionable");
    assert.notEqual(adapter.nativeDelivery.runtime, "active");
    assert.deepEqual(adapter.nativeDelivery.modes, []);
  }
  if (captured) assert.equal(doctor.adapters.find(a => a.adapterId === "codex").outgoingDelivery.state, "configured");
  for (const record of (await ownership(f)).installs) assert.equal(record.deliveryPolicy, "actionable");
});

async function writeClaude(f, inboxAvailable) {
  await writeFile(path.join(f.clientBin, "claude"), `#!${process.execPath}\n`
    + (inboxAvailable ? "// messagingSocketPath\n" : "// inbox temporarily unavailable\n")
    + 'console.log(process.argv.includes("--version") ? "2.1.282 (Claude Code)" : JSON.stringify(process.argv.slice(2)));\n',
  { mode: 0o700 });
}

// What ACC 0.7.x left for a live Claude install: the Channel config, the
// `claude` shim and its ~/.zshrc block, two launchers and a bootstrap cache.
async function leaveChannelInstall(f) {
  const installer = await import(pathToFileURL(path.join(f.installed, "node_modules",
    "@agents-can-communicate", "installer", "src", "index.mjs")).href);
  const shimDir = path.join(f.dataHome, "acc", "bin");
  const rcFile = path.join(f.clientHome, ".zshrc");
  const shell = await writeLegacyShellActivation({ adapterId: "claude_code", command: "claude",
    realExecutable: path.join(f.clientBin, "claude"),
    prefixArgs: ["--dangerously-load-development-channels", "plugin:agents-can-communicate@acc-local"],
    shimDir, rcFile, dataHome: f.dataHome });
  // 0.7.x wrote the Channel config into the plugin tree before it recorded the
  // tree's fingerprint, so the recorded tree includes it.
  const plugin = path.join(f.clientHome, ".claude", "plugins", "marketplaces", "acc-local",
    "agents-can-communicate");
  await writeFile(path.join(plugin, ".mcp.json"),
    '{"mcpServers":{"acc-channel":{"command":"node","args":["acc-claude-channel.mjs"]}}}\n');
  const record = (await ownership(f)).installs.find(item => item.adapterId === "claude_code");
  await installer.recordInstall({ dataHome: f.dataHome, adapterId: "claude_code", version: record.version,
    accVersion: "0.7.1", artifacts: record.artifacts, createdDirectories: record.createdDirectories,
    deliveryPolicy: "actionable", deliveryDecision: record.deliveryDecision,
    nativeActivation: { livePolicy: "actionable", protocolContract: "claude-code-channel-mcp-v1",
      mechanisms: [{ kind: "native-config", artifactIds: ["claude-channel-mcp"] }, shell] } });
  const runtimeBin = path.join(f.dataHome, "acc", "runtime", "bin");
  for (const kind of ["acc-bootstrap", "acc-claude-channel"]) {
    await writeFile(path.join(runtimeBin, `${kind}.mjs`), "// 0.7.x launcher\n", { mode: 0o700 });
  }
  await mkdir(path.join(f.dataHome, "acc", "native-bootstrap"), { recursive: true });
  await writeFile(path.join(f.dataHome, "acc", "native-bootstrap", "claude_code.json"), "{}\n");
  return { shim: path.join(shimDir, "claude"), rcFile, plugin, runtimeBin };
}

// An update from 0.7.x must take the whole Channel path back even while the
// inbox probe fails, keep the recorded consent, and let a later install on a
// supporting client activate the inbox wake.
test("packed update retires a 0.7.x Claude shim and Channel even when the inbox probe fails",
  { skip: !captured }, async t => {
    const f = await createPackedAcc(t);
    await writeFile(path.join(f.clientHome, ".zshrc"), "export USER_STUFF=1\n");
    await writeClaude(f, false);
    assert.deepEqual((await f.acc(["install", "--adapter", "claude_code", "--delivery", "actionable"])).failed, []);
    await f.acc(["update", "--auto", "off"]);
    const old = await leaveChannelInstall(f);
    assert.match(await readFile(old.rcFile, "utf8"), /agents-can-communicate native delivery/);

    const registry = await createUpdateRegistry(t, f);
    const updated = await f.acc(["update"], updateEnv(f, registry));
    assert.equal(updated.activated, true);
    await assert.rejects(readFile(old.shim), { code: "ENOENT" });
    assert.equal(await readFile(old.rcFile, "utf8"), "export USER_STUFF=1\n");
    await assert.rejects(readFile(path.join(old.plugin, ".mcp.json")), { code: "ENOENT" });
    for (const kind of ["acc-bootstrap", "acc-claude-channel"]) {
      await assert.rejects(readFile(path.join(old.runtimeBin, `${kind}.mjs`)), { code: "ENOENT" }, kind);
    }
    await assert.rejects(readFile(path.join(f.dataHome, "acc", "native-bootstrap", "claude_code.json")),
      { code: "ENOENT" });
    const record = (await ownership(f)).installs.find(a => a.adapterId === "claude_code");
    assert.equal(record.nativeActivation ?? null, null);
    assert.equal(record.deliveryPolicy, "actionable", "consent survives the retirement");
    const diagnostic = (await f.acc(["doctor"])).adapters.find(a => a.adapterId === "claude_code");
    assert.equal(diagnostic.bundleVersion, registry.version);
    assert.notEqual(diagnostic.nativeDelivery.eligibility, "eligible");
    assert.deepEqual(diagnostic.owned.modified, []);

    await writeClaude(f, true);
    assert.deepEqual((await f.acc(["install", "--adapter", "claude_code"])).failed, []);
    const activated = (await ownership(f)).installs.find(a => a.adapterId === "claude_code").nativeActivation;
    assert.equal(activated.protocolContract, "claude-code-inbox-socket-v1");
    assert.deepEqual(activated.mechanisms.map(item => item.serviceId), ["claude-code-inbox"]);
    await f.acc(["install", "--adapter", "claude_code", "--delivery", "off"]);
    assert.equal((await ownership(f)).installs[0].deliveryPolicy, "off");
  });

// An uninstall straight from a 0.7.x Claude layout: the shim, its ~/.zshrc
// block, the Channel config and the bootstrap cache all go, and the client home
// is left as ACC found it. 0.7.x also tightened ~/.zshrc to 0600 and recorded
// nothing to undo that with, so the file is set back to 0644 before uninstall to
// show that the retirement itself changes no permission.
test("packed uninstall from a 0.7.x Claude layout leaves the client home as it found it", async t => {
  const f = await createPackedAcc(t);
  await writeFile(path.join(f.clientHome, ".zshrc"), "export USER_STUFF=1\n");
  await writeClaude(f, true);
  const before = await treeSnapshot(f.clientHome);
  assert.deepEqual((await f.acc(["install", "--adapter", "claude_code", "--delivery", "actionable"])).failed, []);
  await f.acc(["update", "--auto", "off"]);
  const old = await leaveChannelInstall(f);
  assert.match(await readFile(old.rcFile, "utf8"), /agents-can-communicate native delivery/);
  await chmod(old.rcFile, 0o644);

  const removed = await f.acc(["uninstall", "--adapter", "claude_code"]);

  assert.deepEqual(removed.failed, []);
  await assert.rejects(readFile(old.shim), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(f.dataHome, "acc", "native-bootstrap", "claude_code.json")),
    { code: "ENOENT" });
  assert.deepEqual(await treeSnapshot(f.clientHome), before);
  assert.equal((await ownership(f)).installs.some(item => item.adapterId === "claude_code"), false);
});

// Work someone put inside the plugin tree keeps the whole tree: the directory
// that holds it is not removed around it.
test("packed uninstall keeps a plugin tree that holds someone's own file, and the file", async t => {
  const f = await createPackedAcc(t);
  await writeClaude(f, true);
  assert.deepEqual((await f.acc(["install", "--adapter", "claude_code"])).failed, []);
  const plugin = path.join(f.clientHome, ".claude", "plugins", "marketplaces", "acc-local",
    "agents-can-communicate");
  await writeFile(path.join(plugin, "my-notes.md"), "mine\n");

  const removed = await f.acc(["uninstall", "--adapter", "claude_code"]);

  assert.deepEqual(removed.failed, []);
  assert.equal(await readFile(path.join(plugin, "my-notes.md"), "utf8"), "mine\n");
  assert.ok(removed.operations[0].kept.includes(path.dirname(plugin)), JSON.stringify(removed.operations[0].kept));
});
