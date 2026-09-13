import { createClaudeCodeAdapter } from "@agents-can-communicate/adapter-claude-code";
import { loadSessionBinding, storeNativeAttempt } from "@agents-can-communicate/adapter-sdk";
import { createCoordinationService } from "@agents-can-communicate/core";
import { establishNativeBinding, livePolicyFrom } from "@agents-can-communicate/hook-runner/native-binding";
import { withSessionLifecycle } from "@agents-can-communicate/hook-runner/session-lifecycle";
import { readInstalledLivePolicy } from "@agents-can-communicate/installer";
import { openFilesystemStore } from "@agents-can-communicate/storage-filesystem";

// SessionStart cannot wait for MCP indefinitely. The endpoint's owner completes
// the same handshake when it starts later, without a prompt or an LLM turn.
// Serialize with the hooks, then reread ownership: a queued startup must never
// publish for a replaced/closed session or undo SessionEnd's retirement.
export async function activateClaudeChannel({ session, service, runtimeDir, dataHome, env,
  deadlineAt = Date.now() + 5_000 }) {
  if (typeof session.harnessSessionId !== "string") return null;
  return withSessionLifecycle({ root: runtimeDir, sessionId: session.harnessSessionId,
    clock: service.clock, deadlineAt }, async () => {
    // A prior hook can die after committing its journal. Recover that close
    // before reading ownership, just as the hook runner does under this lock.
    const { clock, ids } = service;
    const store = await openFilesystemStore({ root: runtimeDir, clock, ids,
      workspaceId: service.store.workspaceId, deadlineAt });
    service = createCoordinationService({ store, clock, ids });
    const current = await loadSessionBinding({ runtimeDir,
      harnessSessionId: session.harnessSessionId });
    if (current?.accSessionId !== session.sessionId || current.generation !== session.generation
      || current.clientPid !== session.clientPid) return null;
    const located = await service.locateSession(session.sessionId);
    if (located?.record.state !== "open" || located.record.generation !== session.generation) return null;
    const policy = livePolicyFrom(env);
    if (policy === "off" || await readInstalledLivePolicy({ dataHome,
      adapterId: "claude_code" }) === "off") return null;
    if (Date.now() >= deadlineAt) return null;
    const result = await establishNativeBinding({ adapter: createClaudeCodeAdapter(),
      event: { kind: "channelReady", sessionId: session.harnessSessionId },
      hookBinding: current, clientVersion: current.clientVersion, platform: current.platform,
      livePolicy: policy, service, runtimeDir, clock: service.clock, env,
      timeoutMs: Math.max(1, Math.min(750, deadlineAt - Date.now())) });
    await storeNativeAttempt({ runtimeDir, harnessSessionId: session.harnessSessionId,
      accSessionId: session.sessionId, generation: session.generation, deadlineAt,
      nativeAttempt: { at: service.clock.now(), event: "channelReady", state: result.state,
        reasonCode: result.reasonCode, policy, policySource: "bootstrap-environment",
        policyStatus: "enabled", clientProcess: "identified" } });
    return result;
  });
}
