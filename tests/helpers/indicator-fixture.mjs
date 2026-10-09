import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCoordinationService } from "@agents-can-communicate/core";
import { openFilesystemStore } from "@agents-can-communicate/storage-filesystem";
import { storeSessionBinding, storeNativeAttempt } from "@agents-can-communicate/adapter-sdk";
import { recordInstall } from "@agents-can-communicate/installer";
import * as cli from "../../packages/cli/src/index.mjs";
import { createFakeClock, createFakeIds } from "./memory-store.mjs";

const NOW = "2026-10-09T04:00:00.000Z";

export async function createIndicatorFixture(t, { adapterId = "claude_code", version = "2.1.295" } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-indicator-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataHome = path.join(root, "data");
  const cwd = path.join(root, "project");
  await mkdir(cwd);
  const clock = createFakeClock(NOW), ids = createFakeIds();
  const nativeSessionId = "native-session";
  const room = await cli.resolveHookWorkspace({ adapterId, dataHome,
    event: { kind: "sessionStart", sessionId: nativeSessionId, cwd },
    env: {}, gitProbe: async () => null, clock, deadlineAt: Date.now() + 10_000 });
  const runtimeDir = cli.runtimePaths({ dataHome, workspaceId: room.descriptor.id }).root;
  const store = await openFilesystemStore({ root: runtimeDir, workspaceId: room.descriptor.id, clock, ids });
  const service = createCoordinationService({ store, clock, ids, pidIsAlive: () => true });
  const session = await service.openSession({ workspaceId: room.descriptor.id,
    participantId: "tester", harness: adapterId, heartbeatCadenceMs: 30_000 });
  const owner = { runtimeDir, harnessSessionId: nativeSessionId,
    accSessionId: session.sessionId, generation: session.generation,
    clientVersion: version, platform: "darwin-arm64", clientPid: process.pid };
  await storeSessionBinding(owner);
  await recordInstall({ dataHome, adapterId, version, artifacts: [], deliveryPolicy: "actionable" });
  const binding = { sessionId: session.sessionId, generation: session.generation, adapterId,
    clientVersion: version, availableModes: ["livePush", "idleWake"], livePolicy: "actionable",
    opaqueEndpointRef: "secret-endpoint", leaseUntil: "2026-10-09T04:02:00.000Z" };
  const read = async () => {
    assert.equal(typeof cli.readIndicator, "function", "the indicator needs a read-only observation path");
    return cli.readIndicator({ adapterId, nativeSessionId, dataHome, now: clock.now() });
  };
  const attempt = (state, reasonCode = null) => storeNativeAttempt({ ...owner,
    nativeAttempt: { at: clock.now(), event: "beforeTurn", state, reasonCode,
      policy: "actionable", policySource: "installation-record", policyStatus: "enabled",
      clientProcess: "identified" } });
  return { root, dataHome, runtimeDir, read, service, session, binding, owner, clock, attempt,
    workspaceId: room.descriptor.id };
}
