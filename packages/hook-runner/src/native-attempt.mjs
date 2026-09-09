import { storeNativeAttempt } from "@agents-can-communicate/adapter-sdk";
import { readInstalledLivePolicyState } from "@agents-can-communicate/installer";

import { establishNativeBinding, LIVE_POLICIES, livePolicyFrom } from "./native-binding.mjs";

// Reserve time for turn projection, status and output before optional disk I/O.
export function nativeDiagnosticDeadline(hookDeadline) {
  const now = Date.now();
  return hookDeadline - now >= 750 ? now + 250 : null;
}

// The diagnostic has its own bounded writer; it never rewrites hook ownership.
// A failed or slow disk leaves the functional hook result intact.
export async function bindNative({ adapter, event, hookBinding, clientVersion, platform,
  context, paths, deadline }) {
  const assertBudget = () => {
    if (Date.now() >= deadline) throw new Error("hook deadline expired");
  };
  assertBudget();
  const policySource = adapter?.nativeDelivery?.policySource === "installation-record"
    ? "installation-record" : "bootstrap-environment";
  const raw = context.env?.ACC_NATIVE_DELIVERY_POLICY;
  const { policy, policyStatus } = policySource === "installation-record"
    ? await readInstalledLivePolicyState({ dataHome: context.dataHome, adapterId: adapter.id })
    : { policy: livePolicyFrom(context.env), policyStatus: raw === undefined ? "missing"
      : !LIVE_POLICIES.includes(raw) ? "invalid" : raw === "off" ? "off" : "enabled" };
  assertBudget();
  const result = await establishNativeBinding({ adapter, event, hookBinding, clientVersion, platform,
    livePolicy: policy, service: context.service, runtimeDir: paths.root,
    clock: context.service.clock, env: context.env,
    timeoutMs: Math.max(1, Math.min(750, deadline - Date.now())) });
  const diagnosticDeadline = nativeDiagnosticDeadline(deadline);
  if (adapter.nativeDelivery && diagnosticDeadline !== null) {
    await storeNativeAttempt({ runtimeDir: paths.root, harnessSessionId: event.sessionId,
      accSessionId: hookBinding.accSessionId, generation: hookBinding.generation, deadlineAt: diagnosticDeadline, nativeAttempt: {
        at: context.service.clock.now(), event: event.kind, state: result.state,
        reasonCode: result.reasonCode, policy, policySource, policyStatus,
        clientProcess: Number.isInteger(hookBinding.clientPid) && hookBinding.clientPid > 0
          ? "identified" : "unknown",
      } }).catch(() => {});
  }
  return result;
}
