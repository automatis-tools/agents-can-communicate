import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile }
  from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createClaudeCodeAdapter } from "@agents-can-communicate/adapter-claude-code";
import { createAccChannel, endpointDir, routeAck, routeReply }
  from "@agents-can-communicate/adapter-claude-code/channel";
import { createCoordinationService } from "@agents-can-communicate/core";
import { createDeliveryRouter } from "@agents-can-communicate/delivery-router";
import { openFilesystemStore } from "@agents-can-communicate/storage-filesystem";
import { runtimePaths } from "@agents-can-communicate/cli";

import { createFakeIds } from "../helpers/memory-store.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));

async function machine(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-cnd-home-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-cnd-data-")));
  const project = path.join(home, "project");
  const bin = path.join(home, "bin");
  await mkdir(path.join(home, ".claude"), { recursive: true });
  await mkdir(project);
  await mkdir(bin);
  const claude = path.join(bin, "claude");
  // A fake client that reports the captured version and carries the Channel
  // protocol needle the probe reads. No client is ever launched for delivery.
  await writeFile(claude, "#!/bin/sh\n# notifications/claude/channel\necho '2.1.258 (Claude Code)'\n");
  await chmod(claude, 0o755);
  t.after(() => Promise.all([home, dataHome]
    .map(directory => rm(directory, { recursive: true, force: true }))));
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    HOME: home, ACC_DATA_HOME: dataHome, ACC_NO_UPDATE_CHECK: "1",
    ACC_PROBE_TIMEOUT_MS: "30000", SHELL: "/bin/zsh", GIT_DIR: "", GIT_WORK_TREE: "" };
  return { home, dataHome, project, bin, env };
}

const acc = path.join(repo, "bin", "acc.mjs");
const run = (place, args) => import("node:child_process").then(({ execFile }) =>
  new Promise((resolve, reject) => execFile(process.execPath, [acc, ...args, "--cwd", place.project],
    { env: place.env }, (error, stdout, stderr) =>
      error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }))));

test("an eligible live install writes a channel .mcp.json pointing at packed binaries", async t => {
  const place = await machine(t);
  const installed = await run(place, ["install", "--adapter", "claude_code", "--delivery",
    "actionable", "--home", place.home]);
  assert.match(installed.stdout, /native delivery is wired/i);
  const source = path.join(place.home, ".claude", "plugins", "marketplaces", "acc-local",
    "agents-can-communicate", ".mcp.json");
  const versions = await readdir(path.join(place.home, ".claude", "plugins", "cache", "acc-local",
    "agents-can-communicate"));
  const cached = path.join(place.home, ".claude", "plugins", "cache", "acc-local",
    "agents-can-communicate", versions[0], ".mcp.json");
  for (const file of [source, cached]) {
    const mcp = JSON.parse(await readFile(file, "utf8"));
    const server = mcp.mcpServers["acc-channel"];
    assert.equal(server.command, process.execPath);
    assert.match(server.args[0], /bin\/acc-claude-channel\.mjs$/);
    assert.equal(path.isAbsolute(server.args[0]), true);
    assert.match(server.args[0], /agents-can-communicate.*bin\/acc-claude-channel\.mjs$/);
  }
  // A shim was written for the ordinary `claude` command, carrying the flag.
  const shim = path.join(place.dataHome, "acc", "bin", "claude");
  assert.match(await readFile(shim, "utf8"), /dangerously-load-development-channels/);
  await run(place, ["uninstall", "--adapter", "claude_code", "--home", place.home]);
  await assert.rejects(readFile(source), { code: "ENOENT" });
});

test("a message is durably recorded before a native offer, and an explicit reply is a real answer",
  async t => {
    const place = await machine(t);
    const clock = { now: () => new Date().toISOString() };
    const ids = createFakeIds();
    const descriptorId = "workspace_native_fixture";
    const paths = runtimePaths({ dataHome: place.dataHome, workspaceId: descriptorId,
      workspaceRoots: [place.project] });
    const store = await openFilesystemStore({ root: paths.root, clock, ids,
      workspaceId: descriptorId });
    const service = createCoordinationService({ store, clock, ids, pidIsAlive: () => true });
    const sender = await service.openSession({ workspaceId: descriptorId, participantId: "sender",
      sessionId: "session_sender", harness: "fixture", heartbeatCadenceMs: 30_000 });
    const receiver = await service.openSession({ workspaceId: descriptorId, participantId: "models",
      sessionId: "session_models", harness: "claude_code", heartbeatCadenceMs: 30_000 });

    // The receiver's live Channel, exactly as its acc-claude-channel binary would
    // compose it, resolving replies through the real conversation service.
    const session = { sessionId: receiver.sessionId, generation: receiver.generation };
    const channel = createAccChannel({ endpointDir: endpointDir(paths.root), clientPid: 4242,
      write: () => {},
      routeReply: ({ messageId, body }) => routeReply({ service, session, messageId, body }),
      routeAck: ({ messageId }) => routeAck({ service, session, messageId }) });
    await channel.listen();
    await channel.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    await service.publishDeliveryBinding({ sessionId: receiver.sessionId,
      generation: receiver.generation, adapterId: "claude_code", clientVersion: "2.1.258",
      availableModes: ["livePush"], livePolicy: "actionable",
      opaqueEndpointRef: channel.endpointId,
      leaseUntil: new Date(Date.now() + 60_000).toISOString() });

    const adapter = createClaudeCodeAdapter();
    let stateAtOffer = null;
    const observed = { ...adapter, offerMessage: async input => {
      stateAtOffer = (await store.snapshot(descriptorId, { kinds: ["receipt"] }))
        .receipts.find(item => item.messageId === input.message.messageId)?.state ?? null;
      return adapter.offerMessage(input);
    } };
    const router = createDeliveryRouter({ service, adapters: { claude_code: observed }, clock });

    try {
    const question = await service.sendMessage({ sessionId: sender.sessionId,
      generation: sender.generation, clientMessageId: "client_q", toParticipantIds: ["models"],
      kind: "question", obligation: "reply", subject: "Native?", body: "what is 2 + 2?",
      artifacts: [], inReplyTo: null, handoff: null });
    const [outcome] = await router.offer(question);
    assert.equal(stateAtOffer, "queued", "the record must exist and be queued before the offer");
    assert.deepEqual(outcome, { recipientParticipantId: "models", outcome: "offered",
      transport: "claude-channel" });

    // The model answers through the channel tool; a real ACC answer appears.
    await channel.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call",
      params: { name: "acc_reply", arguments: { messageId: question.messageId, body: "4" } } }));
    const answers = (await store.snapshot(descriptorId, { kinds: ["message"] })).messages
      .filter(item => item.inReplyTo === question.messageId && item.kind === "answer");
    assert.equal(answers.length, 1);
    assert.equal(answers[0].fromParticipantId, "models");
    } finally {
      channel.close();
    }
  });
