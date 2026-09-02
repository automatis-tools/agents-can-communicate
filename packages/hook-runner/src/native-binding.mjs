import { validateNativeHandshake } from "@agents-can-communicate/adapter-sdk";
import { EXIT } from "@agents-can-communicate/protocol";

// The hook side of native delivery: one bounded, fail-open attempt to bind
// this exact ACC session generation to the vendor session the adapter can
// reach, then a sanitized binding published for the router. The helper, not
// the adapter, supplies adapter id, client facts, session id, and generation;
// the adapter supplies only closed handshake facts. Nothing here throws into
// the hook path, and no endpoint reference ever leaves through the result.

export const LIVE_POLICIES = Object.freeze(["off", "actionable", "all"]);
export const NATIVE_BINDING_STATES = Object.freeze(["active", "off", "degraded", "unsupported"]);
const DEFAULT_TIMEOUT_MS = 750;
const DEFAULT_CADENCE_MS = 60_000;

// Reasons the static rule refused: the client will not change within the
// session, so the state is "unsupported" rather than a retryable "degraded".
const STATIC_REASONS = new Set(["native_delivery_unsupported", "platform_not_captured",
  "version_unavailable", "prerelease_not_captured", "below_minimum_version",
  "known_bad_version"]);

// Only the value a successful owned shell bootstrap exported counts; anything
// else - missing, blank, differently cased, a number - is off.
export function livePolicyFrom(env) {
  const value = env?.ACC_NATIVE_DELIVERY_POLICY;
  return LIVE_POLICIES.includes(value) ? value : "off";
}

const isPid = value => Number.isInteger(value) && value > 0;

export async function establishNativeBinding({ adapter, event, hookBinding, clientVersion,
  platform, livePolicy, service, runtimeDir, clock,
  timeoutMs = DEFAULT_TIMEOUT_MS, heartbeatCadenceMs = DEFAULT_CADENCE_MS }) {
  const outcome = (state, reasonCode, modes = []) =>
    Object.freeze({ state, reasonCode, modes: Object.freeze([...modes]) });
  const sessionId = hookBinding?.accSessionId;
  const generation = hookBinding?.generation;
  if (typeof sessionId !== "string" || typeof generation !== "string") return outcome("off", null);
  const policy = LIVE_POLICIES.includes(livePolicy) ? livePolicy : "off";
  const clear = () => service.clearDeliveryBinding({ sessionId, generation }).catch(() => null);
  if (policy === "off") {
    await clear();
    return outcome("off", null);
  }
  if (adapter?.nativeDelivery === undefined || typeof adapter.bindNativeSession !== "function") {
    return outcome("unsupported", "native_delivery_unsupported");
  }
  const clientPid = hookBinding.clientPid;
  if (!isPid(clientPid)) {
    await clear();
    return outcome("degraded", "client_process_unknown");
  }
  // Whatever this generation published before is retired first, so a failed
  // re-handshake can never leave yesterday's endpoint reachable.
  await clear();
  let timer = null;
  try {
    const budget = Math.max(1, Math.floor(timeoutMs));
    const handshake = await Promise.race([
      adapter.bindNativeSession({ event, clientPid, clientVersion, runtimeDir, timeoutMs: budget }),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("native handshake timed out"),
          { code: "ETIMEDOUT" })), budget);
      }),
    ]);
    const verdict = validateNativeHandshake(adapter, { clientVersion, platform, handshake });
    if (!verdict.ok) {
      return outcome(STATIC_REASONS.has(verdict.reasonCode) ? "unsupported" : "degraded",
        verdict.reasonCode);
    }
    const now = Date.parse(clock.now());
    const lease = Date.parse(verdict.leaseUntil);
    if (!(lease > now)) return outcome("degraded", "handshake_failed");
    const ceiling = now + 2 * heartbeatCadenceMs;
    const leaseUntil = lease > ceiling ? new Date(ceiling).toISOString() : verdict.leaseUntil;
    await service.publishDeliveryBinding({
      sessionId, generation, adapterId: adapter.id, clientVersion,
      availableModes: [...verdict.modes], livePolicy: policy,
      opaqueEndpointRef: verdict.opaqueEndpointRef, leaseUntil,
    });
    return outcome("active", null, verdict.modes);
  } catch (error) {
    await clear();
    const reasonCode = error?.code === "ETIMEDOUT" ? "handshake_timeout"
      : error?.code === EXIT.CONFLICT ? "session_generation_stale" : "handshake_failed";
    return outcome("degraded", reasonCode);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
