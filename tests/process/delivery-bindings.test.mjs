import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createCoordinationService } from "@agents-can-communicate/core";
import { createDeliveryRouter } from "@agents-can-communicate/delivery-router";
import { openFilesystemStore } from "@agents-can-communicate/storage-filesystem";
import { runtimePaths } from "@agents-can-communicate/cli";

import { recordAndOffer } from "../../packages/cli/src/main.mjs";

import { createFakeIds } from "../helpers/memory-store.mjs";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const acc = path.join(repo, "bin", "acc.mjs");

async function machine(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-delivery-home-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-delivery-data-")));
  const project = path.join(home, "project");
  await mkdir(project);
  t.after(() => Promise.all([home, dataHome]
    .map(directory => rm(directory, { recursive: true, force: true }))));
  const env = { ...process.env, HOME: home, ACC_DATA_HOME: dataHome,
    ACC_NO_UPDATE_CHECK: "1", GIT_DIR: "", GIT_WORK_TREE: "" };
  const command = (...args) => run(process.execPath, [acc, ...args, "--cwd", project, "--json"],
    { env });
  return { command, dataHome, env, home, project };
}

test("the executable reports a binding without exposing its endpoint", async t => {
  const place = await machine(t);
  const attached = JSON.parse((await place.command("attach", "--participant", "models",
    "--session", "session_models")).stdout).data;
  const before = JSON.parse((await place.command("status")).stdout).data;
  const paths = runtimePaths({ dataHome: place.dataHome, workspaceId: before.workspaceId,
    workspaceRoots: [place.project] });
  const clock = { now: () => new Date().toISOString() };
  const ids = createFakeIds();
  const store = await openFilesystemStore({ root: paths.root, clock, ids,
    workspaceId: before.workspaceId });
  const service = createCoordinationService({ store, clock, ids, pidIsAlive: () => true });
  await service.publishDeliveryBinding({ sessionId: attached.sessionId,
    generation: attached.generation, adapterId: "fixture_adapter", clientVersion: "1.2.3",
    availableModes: ["livePush"], livePolicy: "actionable",
    opaqueEndpointRef: "never-print-this-endpoint",
    leaseUntil: new Date(Date.now() + 60_000).toISOString() });

  const status = JSON.parse((await place.command("status")).stdout).data;
  assert.equal(status.deliveryBindings[0].reachable, true);
  assert.equal(JSON.stringify(status).includes("never-print-this-endpoint"), false);
});

test("installed CLI carries requested delivery but real adapters remain fallback-only", async t => {
  const place = await machine(t);
  const result = JSON.parse((await run(process.execPath, [acc, "install", "--adapter", "codex",
    "--delivery", "actionable", "--home", place.home, "--dry-run", "--json"],
  { env: place.env })).stdout).data;
  const [operation] = result.plan.operations;

  assert.equal(operation.livePolicy, "actionable");
  assert.equal(operation.effectiveLivePolicy, "off");
  assert.match(operation.deliveryDiagnostic, /durable fallback/);
});

test("filesystem composition records before an offer failure and keeps command success", async t => {
  const place = await machine(t);
  const recipient = JSON.parse((await place.command("attach", "--participant", "models",
    "--session", "session_models")).stdout).data;
  const status = JSON.parse((await place.command("status")).stdout).data;
  const paths = runtimePaths({ dataHome: place.dataHome, workspaceId: status.workspaceId,
    workspaceRoots: [place.project] });
  const clock = { now: () => "2026-09-01T20:00:00.000Z" };
  const ids = createFakeIds();
  const store = await openFilesystemStore({ root: paths.root, clock, ids,
    workspaceId: status.workspaceId });
  const service = createCoordinationService({ store, clock, ids, pidIsAlive: () => true });
  const sender = await service.openSession({ workspaceId: status.workspaceId,
    participantId: "sender", sessionId: "session_sender", harness: "fixture",
    heartbeatCadenceMs: 30_000 });
  await service.publishDeliveryBinding({ sessionId: recipient.sessionId,
    generation: recipient.generation, adapterId: "fixture_adapter", clientVersion: "1.2.3",
    availableModes: ["livePush"], livePolicy: "actionable",
    opaqueEndpointRef: "never-print-this-process-endpoint",
    leaseUntil: "2026-09-01T20:01:00.000Z" });
  let stateAtOffer;
  const platform = `${process.platform}-${process.arch}`;
  const adapter = { id: "fixture_adapter", client: { command: "fixture-client" },
    capabilities: { delivery: { livePush: true } }, certification: { evidence: [{
      result: "pass", client: "fixture-client", version: "1.2.3",
      platform, capability: "delivery.livePush",
    }] }, nativeDelivery: { minimumByPlatform: { [platform]: "1.2.3" },
      anchors: [{ platform, version: "1.2.3", protocolContract: "fixture-native-v1" }],
      knownBad: [], activationKinds: ["shell-bootstrap"] },
    offerMessage: async ({ message }) => {
      stateAtOffer = (await store.snapshot(status.workspaceId, { kinds: ["receipt"] }))
        .receipts.find(item => item.messageId === message.messageId).state;
      throw new Error("secret process transport detail");
    } };
  const router = createDeliveryRouter({ service, adapters: { fixture_adapter: adapter }, clock });

  const result = await recordAndOffer({ router, record: () => service.sendMessage({
    sessionId: sender.sessionId, generation: sender.generation,
    clientMessageId: "client_process_request", toParticipantIds: ["models"],
    kind: "request", obligation: "reply", subject: "Process request", body: "Do work",
    artifacts: [], inReplyTo: null, handoff: null,
  }) });

  assert.equal(stateAtOffer, "queued");
  assert.equal(result.recorded.body, "Do work");
  assert.deepEqual(result.delivery, [{ recipientParticipantId: "models", outcome: "queued",
    transport: "durable", errorCode: "transport_error" }]);
  assert.equal(JSON.stringify(result).includes("secret process transport detail"), false);
  const receipt = (await store.snapshot(status.workspaceId, { kinds: ["receipt"] })).receipts
    .find(item => item.messageId === result.recorded.messageId);
  assert.equal(receipt.state, "queued");
});
