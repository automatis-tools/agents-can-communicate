import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
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
const shellLiteral = value => `'${String(value).replaceAll("'", "'\"'\"'")}'`;

async function machine(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-delivery-home-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-delivery-data-")));
  const project = path.join(home, "project");
  const codexHome = path.join(home, ".codex");
  const bin = path.join(home, "bin");
  const argvLog = path.join(home, "fake-codex-argv.log");
  await Promise.all([mkdir(project), mkdir(codexHome, { recursive: true }), mkdir(bin)]);
  await writeFile(path.join(codexHome, "config.toml"), 'model = "gpt-5"\n');
  const codex = path.join(bin, "codex");
  await writeFile(codex, `#!/bin/sh
printf '%s|%s|%s\\n' "$CODEX_HOME" "$#" "$*" >> ${shellLiteral(argvLog)}
printf '%s\\n' 'codex-cli 0.153.4'
`);
  await chmod(codex, 0o755);
  t.after(() => Promise.all([home, dataHome]
    .map(directory => rm(directory, { recursive: true, force: true }))));
  // The ACC process needs only this disposable fake client plus system shell
  // tools. Do not inherit operator ACC, Codex, or Node environment state.
  const env = { PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter), HOME: home,
    CODEX_HOME: codexHome, ACC_DATA_HOME: dataHome, ACC_NO_UPDATE_CHECK: "1",
    ACC_PROBE_TIMEOUT_MS: "30000", GIT_DIR: "", GIT_WORK_TREE: "" };
  const command = (...args) => run(process.execPath, [acc, ...args, "--cwd", project, "--json"],
    { env });
  const argv = async () => (await readFile(argvLog, "utf8")).trimEnd().split("\n")
    .filter(Boolean).map(line => {
      const [observedHome, argc, args] = line.split("|");
      return { home: observedHome, argc: Number(argc), args };
    });
  return { argv, codexHome, command, dataHome, env, home, project };
}

async function assertOnlyVersionProbes(place) {
  const calls = await place.argv();
  assert.ok(calls.length > 0, "ACC never probed the isolated fake Codex executable");
  assert.deepEqual(calls, calls.map(() => ({ home: place.codexHome, argc: 1, args: "--version" })),
    "the dry run started a daemon or rewrote Codex launch arguments");
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
    leaseUntil: new Date(Date.now() + 60_000).toISOString(), retiredAt: null });

  const status = JSON.parse((await place.command("status")).stdout).data;
  assert.equal(status.deliveryBindings[0].reachable, true);
  assert.equal(JSON.stringify(status).includes("never-print-this-endpoint"), false);
});

test("requested Codex consent stays off without an isolated LocalDaemon session", async t => {
  const place = await machine(t);
  const result = JSON.parse((await place.command("install", "--adapter", "codex",
    "--delivery", "actionable", "--home", place.home, "--dry-run")).stdout).data;
  const [operation] = result.plan.operations;

  assert.equal(operation.livePolicy, "actionable");
  assert.equal(operation.effectiveLivePolicy, "off");
  assert.equal(operation.clientVersion, "0.153.4");
  assert.match(operation.deliverySummary, /consent saved.*not active/);
  assert.match(operation.deliveryDiagnostic, /fallback: acc inbox/);
  await assertOnlyVersionProbes(place);
  await assert.rejects(stat(path.join(place.codexHome, "app-server-control")), { code: "ENOENT" },
    "the dry run created a LocalDaemon control directory");
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
    leaseUntil: "2026-09-01T20:01:00.000Z", retiredAt: null });
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
