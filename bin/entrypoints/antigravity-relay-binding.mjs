import { createAntigravityAdapter } from "@agents-can-communicate/adapter-antigravity";
import { loadSessionBinding, storeNativeAttempt } from "@agents-can-communicate/adapter-sdk";
import { createCoordinationService } from "@agents-can-communicate/core";
import { establishNativeBinding } from "@agents-can-communicate/hook-runner/native-binding";
import { withSessionLifecycle } from "@agents-can-communicate/hook-runner/session-lifecycle";
import { readInstalledLivePolicyState } from "@agents-can-communicate/installer";
import { openFilesystemStore } from "@agents-can-communicate/storage-filesystem";

// No hook runs when the agent starts a relay mid-turn, and the next
// PreInvocation can be hours away. The relay publishes its own binding the way
// the Claude Code Channel does: under the session's lifecycle lock, after
// rereading ownership, so a queued start never publishes for a replaced or
// closed session.
export async function activateAntigravityRelay({ session, service, runtimeDir, dataHome,
  adapter = createAntigravityAdapter(), deadlineAt = Date.now() + 5_000 }) {
  if (typeof session.harnessSessionId !== "string") return null;
  return withSessionLifecycle({ root: runtimeDir, sessionId: session.harnessSessionId,
    clock: service.clock, deadlineAt }, async () => {
    const { clock, ids } = service;
    const store = await openFilesystemStore({ root: runtimeDir, clock, ids,
      workspaceId: service.store.workspaceId, deadlineAt });
    const current = createCoordinationService({ store, clock, ids });
    const binding = await loadSessionBinding({ runtimeDir, harnessSessionId: session.harnessSessionId });
    if (binding?.accSessionId !== session.sessionId || binding.generation !== session.generation
      || binding.clientPid !== session.clientPid) return null;
    const located = await current.locateSession(session.sessionId);
    if (located?.record.state !== "open" || located.record.generation !== session.generation) return null;
    const { policy, policyStatus } = await readInstalledLivePolicyState({ dataHome,
      adapterId: adapter.id });
    if (policy === "off" || Date.now() >= deadlineAt) return null;
    const result = await establishNativeBinding({ adapter,
      event: { kind: "relayReady", sessionId: session.harnessSessionId },
      hookBinding: binding, clientVersion: binding.clientVersion, platform: binding.platform,
      livePolicy: policy, service: current, runtimeDir, clock, env: {},
      timeoutMs: Math.max(1, Math.min(750, deadlineAt - Date.now())) });
    await storeNativeAttempt({ runtimeDir, harnessSessionId: session.harnessSessionId,
      accSessionId: session.sessionId, generation: session.generation, deadlineAt,
      nativeAttempt: { at: clock.now(), event: "relayReady", state: result.state,
        reasonCode: result.reasonCode, policy, policySource: "installation-record", policyStatus,
        clientProcess: "identified" } }).catch(() => {});
    return result;
  });
}
