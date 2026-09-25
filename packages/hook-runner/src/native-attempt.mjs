import { storeNativeAttempt } from "@agents-can-communicate/adapter-sdk";
import { readInstalledLivePolicyState } from "@agents-can-communicate/installer";

import { establishNativeBinding } from "./native-binding.mjs";

// A cold worker plus the write has to finish inside this window. 250 ms was
// not enough on a busy CI runner, so the attempt file never appeared and
// doctor reported no attempt. 1.5 s still abandons a stuck disk, and the
// extra 500 ms stays available for turn projection, status and output.
const DIAGNOSTIC_BUDGET_MS = 1_500;
const DIAGNOSTIC_FLOOR_MS = 250;
const AFTER_DIAGNOSTIC_MS = 500;

export function nativeDiagnosticDeadline(hookDeadline) {
  const now = Date.now();
  const remaining = hookDeadline - now;
  // Below this, even the old quarter-second write would crowd out projection.
  if (remaining < DIAGNOSTIC_FLOOR_MS + AFTER_DIAGNOSTIC_MS) return null;
  return now + Math.min(DIAGNOSTIC_BUDGET_MS, remaining - AFTER_DIAGNOSTIC_MS);
}

// The diagnostic has its own bounded writer; it never rewrites hook ownership.
// A failed or slow disk leaves the functional hook result intact.
export async function bindNative({ adapter, event, hookBinding, clientVersion, platform,
  context, paths, deadline }) {
  const assertBudget = () => {
    if (Date.now() >= deadline) throw new Error("hook deadline expired");
  };
  assertBudget();
  // The install record is the only consent a hook reads; see
  // validateNativeDeliveryContract for the environment source this replaced.
  const policySource = "installation-record";
  const { policy, policyStatus } = await readInstalledLivePolicyState({ dataHome: context.dataHome,
    adapterId: adapter.id });
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

const HINT_MAX_BYTES = 512;
const HINT_MAX_MS = 250;

function asHint(value) {
  if (typeof value === "string") return { line: value, release: async () => {} };
  if (value !== null && typeof value === "object" && typeof value.line === "string") {
    return { line: value.line,
      release: typeof value.release === "function" ? value.release : async () => {} };
  }
  if (value !== null && typeof value === "object" && typeof value.release === "function") {
    return { line: "", release: value.release };
  }
  return null;
}

function usableHint(line) {
  return line !== "" && !/[\r\n]/.test(line) && Buffer.byteLength(line, "utf8") <= HINT_MAX_BYTES;
}

// An adapter may release with a synchronous function. Calling `.catch` on its
// return value throws when that return value is undefined, and a throw from
// the function itself must not become a failed hook.
export function callRelease(release) {
  if (typeof release !== "function") return Promise.resolve();
  try {
    return Promise.resolve(release()).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

/**
 * One line an adapter asks the agent to act on, when the agent itself can fix
 * a degraded native binding - Antigravity's relay is started from the agent's
 * own shell, and nothing else can start it. Bounded and fail-open: a slow or
 * failing adapter costs the turn nothing, and anything but one short line is
 * dropped rather than trusted into model context.
 *
 * A string has nothing reserved. `{ line, release }` has reserved an ask; this
 * function calls `release` when it drops the line, including when the adapter
 * answers after the budget. The caller releases a line it does not deliver.
 */
export async function nativeActivationHintFor({ adapter, event, nativeBinding, binding, context,
  paths, deadline }) {
  if (typeof adapter?.nativeActivationHint !== "function" || nativeBinding?.state !== "degraded") return null;
  const budget = Math.min(HINT_MAX_MS, deadline - Date.now() - HINT_MAX_MS);
  if (budget <= 0) return null;
  let timer = null;
  let keep = false;
  // The call sits inside then so a synchronous throw becomes a rejection.
  // Promise.resolve(adapter.nativeActivationHint()) evaluates the call first
  // and lets that throw escape the hook.
  const pending = Promise.resolve().then(() => adapter.nativeActivationHint({ event, nativeBinding,
    runtimeDir: paths.root, clientPid: binding?.clientPid, env: context.env })).then(asHint, () => null);
  try {
    const taken = await Promise.race([
      pending,
      new Promise(resolve => { timer = setTimeout(resolve, budget, null); }),
    ]);
    if (taken !== null && usableHint(taken.line)) {
      keep = true;
      return taken;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (timer !== null) clearTimeout(timer);
    // A late or rejected answer still holds its reservation. Do not wait for
    // it: an adapter that never settles must not hold the hook.
    if (!keep) pending.then(taken => callRelease(taken?.release)).catch(() => {});
  }
}
