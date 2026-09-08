import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { controlledCodexDaemon, THREAD } from "../helpers/codex-daemon.mjs";
import { connectMcp, PROTOCOL_META } from "../helpers/mcp-client.mjs";
import { createPackedAcc } from "../helpers/packed-acc.mjs";

// Controlled Unix transport, not a vendor capability capture: execute the actual
// packed entrypoint and adapter against an exact receiver-owned endpoint.
test("installed MCP routes with consent from its nondefault data home", { timeout: 60_000 }, async t => {
  const packed = await createPackedAcc(t);
  const module = (name, file = "index") => import(pathToFileURL(path.join(packed.installed,
    "node_modules", "@agents-can-communicate", name, "src", `${file}.mjs`)));
  const { discoverWorkspace, createGitProbe, platformDataHome, runtimePaths } = await module("cli");
  const { createCoordinationService } = await module("core");
  const { openFilesystemStore } = await module("storage-filesystem");
  const { createId } = await module("protocol");
  const { recordInstall } = await module("installer");
  const { bindNativeSession } = await module("adapter-codex", "native-delivery");
  const descriptor = await discoverWorkspace({ cwd: packed.project, env: packed.env,
    gitProbe: createGitProbe() });
  const paths = runtimePaths({ dataHome: packed.dataHome,
    workspaceId: descriptor.id, workspaceRoots: descriptor.roots });
  const clock = { now: () => new Date().toISOString() };
  const ids = { next: kind => createId(kind, randomBytes) };
  const store = await openFilesystemStore({ root: paths.root, clock, ids, workspaceId: descriptor.id });
  const service = createCoordinationService({ store, clock, ids });
  const receiver = await service.openSession({ workspaceId: descriptor.id,
    participantId: "receiver", harness: "codex", heartbeatCadenceMs: 30_000 });
  const daemon = await controlledCodexDaemon(t, { cwd: packed.project });
  const native = await bindNativeSession({ event: { sessionId: THREAD, cwd: packed.project },
    clientPid: process.pid, clientVersion: "0.152.1", runtimeDir: paths.root, env: daemon.env });
  assert.equal(native.supported, true);
  await service.publishDeliveryBinding({ sessionId: receiver.sessionId, generation: receiver.generation,
    adapterId: "codex", clientVersion: "0.152.1", availableModes: ["livePush"], livePolicy: "all",
    opaqueEndpointRef: native.opaqueEndpointRef, leaseUntil: native.leaseUntil });
  const otherEnv = { ...packed.env, ACC_DATA_HOME: "", XDG_DATA_HOME: "" };
  const otherHome = platformDataHome({ platform: process.platform, env: otherEnv });
  assert.notEqual(otherHome, packed.dataHome);
  const policy = (dataHome, deliveryPolicy) => recordInstall({ dataHome, adapterId: "codex",
    version: "0.152.1", artifacts: [], deliveryPolicy });
  const mcp = connectMcp({ binary: packed.mcpBin, cwd: packed.project, dataHome: packed.dataHome,
    env: { ...packed.env, ACC_MCP_WORKSPACE: packed.project } });
  t.after(() => mcp.close());
  for (const [selected, other, expected] of [["actionable", "off", "offered"], ["off", "all", "queued"]]) {
    await policy(packed.dataHome, selected);
    await policy(otherHome, other);
    const queueBefore = daemon.state.queue.length;
    const callsBefore = daemon.state.calls.length;
    const result = await mcp.request("tools/call", { name: "acc_message",
      arguments: { to: ["receiver"], kind: "question", subject: selected, body: "Controlled policy regression",
        clientMessageId: `policy_${selected}` }, _meta: PROTOCOL_META("2026-07-28") });
    assert.equal(result.error, undefined);
    assert.equal(result.result.isError, undefined, JSON.stringify(result.result));
    const { message, delivery } = result.result.structuredContent;
    assert.equal(delivery[0].outcome, expected, JSON.stringify(delivery));
    assert.equal((await service.readReceipt({ messageId: message.messageId,
      recipientParticipantId: "receiver" })).state, expected);
    if (selected === "off") {
      assert.equal(delivery[0].errorCode, "delivery_disabled");
      assert.equal(daemon.state.calls.length, callsBefore);
      assert.equal(daemon.state.queue.length, queueBefore);
    } else {
      assert.equal(delivery[0].transport, "codex-app-server");
      assert.equal(daemon.state.queue.length, queueBefore + 1);
      assert.equal(daemon.state.queue.at(-1).clientUserMessageId, message.messageId);
      assert.equal(daemon.state.queue.at(-1).threadId, THREAD);
    }
  }
});
