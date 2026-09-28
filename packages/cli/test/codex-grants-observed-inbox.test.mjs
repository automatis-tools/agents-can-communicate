import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { newEndpointId, writeInboxEndpoint }
  from "../../adapter-claude-code/src/inbox-endpoint.mjs";
import { ALL_ADAPTERS, clientContext } from "../src/install-command.mjs";

// Review of #217: a Claude Code session started with its own absolute
// CLAUDE_CODE_TMPDIR binds its inbox outside the directories the installer's
// environment implies. Once ACC has bound it, install and doctor know the
// directory from the binding's record: doctor names it until the Codex profile
// allows it, and the next install does.
test("a bound Claude Code inbox outside the environment's directories is required and granted", async t => {
  const base = mkdtempSync("/tmp/acc-obs-cli-");
  const server = net.createServer(() => {});
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(base, { recursive: true, force: true });
  });
  const home = path.join(base, "home");
  const dataHome = path.join(base, "data");
  const stateRoot = path.join(dataHome, "acc");
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const context = () => ({ ...clientContext(home, stateRoot, { env: {}, dataHome, platform: "darwin" }),
    node: process.execPath, runner: path.join(repo, "bin", "acc-hook.mjs"),
    cli: path.join(repo, "bin", "acc.mjs"), clientVersion: "0.157.1", platform: "darwin-arm64",
    requestedLivePolicy: "actionable", livePolicy: "off" });
  const codex = ALL_ADAPTERS().find(adapter => adapter.id === "codex");

  await codex.install(context());
  assert.equal((await codex.detect(context())).outgoingDelivery.state, "configured");

  // A session bound through the adapter's own record writer, as its hook does.
  const socketPath = path.join(base, "own-tmp", "cc-socks", "4242.sock");
  mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await new Promise(resolve => server.listen(socketPath, resolve));
  chmodSync(socketPath, 0o600);
  await writeInboxEndpoint({ runtimeDir: path.join(stateRoot, "workspaces", "workspace_one"),
    record: { schemaVersion: 1, endpointId: newEndpointId(), socketPath, configDir: path.join(home, ".claude"),
      clientPid: 4242, sessionId: "session-x", clientVersion: "2.1.283",
      protocolContract: "claude-code-inbox-socket-v1", leaseUntil: "2026-09-28T00:00:00.000Z",
      reception: "delivered" } });
  const granted = path.join(realpathSync.native(base), "own-tmp", "cc-socks");

  const stale = await codex.detect(context());
  assert.equal(stale.outgoingDelivery.state, "unverified");
  assert.ok(stale.needsAction.some(line => line.includes(`missing ${granted}`)
    && line.includes("run acc install --adapter codex")), stale.needsAction.join("\n"));

  await codex.install(context());
  assert.ok(readFileSync(path.join(home, ".codex", "config.toml"), "utf8")
    .includes(`${JSON.stringify(granted)} = "allow"`));
  assert.equal((await codex.detect(context())).outgoingDelivery.state, "configured");
});
