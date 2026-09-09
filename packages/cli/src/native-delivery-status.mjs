import { describeNativeReason } from "@agents-can-communicate/installer";

export function describeNative(native, { clientVersion } = {}) {
  const differs = native.runtime === "active" && native.sessionPolicy
    && native.sessionPolicy !== native.policy;
  const enabled = (native.configured ? `enabled (${native.policy})` : "off")
    + (differs ? " for new sessions" : "");
  const availability = native.eligibility === "eligible" ? "available"
    : `${native.eligibility === "unsupported" ? "unavailable" : "readiness unverified"}: `
      + describeNativeReason(native.reasonCode, { clientVersion, minimumVersion: native.minimumVersion });
  const runtime = native.runtime === "active"
    ? `active${differs ? ` (session policy: ${native.sessionPolicy})` : ""}`
    : native.runtime === "degraded" ? "channel unreachable"
      : native.configured && native.runtime === "waiting"
        ? "no live channel bound in this workspace" : null;
  return [availability, enabled, ...(runtime ? [runtime] : [])].join("; ");
}

export function nativeRemediation(entry) {
  const native = entry.nativeDelivery;
  if (!(entry.present || entry.installed) || native.eligibility === "unsupported") return [];
  const steps = [];
  if (!native.configured && native.runtime !== "active") {
    steps.push(`acc install --adapter ${entry.adapterId} --delivery actionable`
      + "  # opt in to automatic peer requests; may spend tokens");
  } else if (native.configured && native.activation === "missing") {
    steps.push(`acc install --adapter ${entry.adapterId}`
      + "  # complete the missing native launch setup from a supported shell");
  } else if (native.configured && native.runtime !== "active") {
    steps.push(`${entry.displayName}: no verified live channel in this workspace; `
      + "open a new terminal, start a new client session and check its integration/channel prompts; "
      + "then run acc doctor here");
  }
  if (native.reasonCode === "native_endpoint_unavailable") {
    steps.push(`${entry.displayName}: check the client's local delivery service setup; `
      + "ACC does not start or restart that service");
  } else if (native.reasonCode === "native_session_unavailable") {
    steps.push(`${entry.displayName}: open a session connected to the client's local delivery service`);
  }
  return steps;
}

// One closed native-delivery report per adapter, built only from detection,
// ownership, and later the live binding facts - never inferred from a
// configured shim alone. eligibility is what the client could do; configured is
// whether a policy was recorded; policy is that recorded policy; runtime is
// filled in from current bindings; modes and reasonCode carry the closed
// detail. runtime "active" never means the model read anything.
export function nativeState(detected, recordedPolicy, { contract, activation } = {}) {
  const native = detected ?? { state: "unsupported", reasonCode: "native_delivery_unsupported" };
  const eligibility = native.state === "eligible" ? "eligible"
    : native.state === "degraded" ? "degraded" : "unsupported";
  const policy = recordedPolicy ?? "off";
  const configured = policy !== "off";
  const modes = native.state === "eligible" && Array.isArray(native.probe?.modes)
    ? [...native.probe.modes] : [];
  const runtime = eligibility === "unsupported" ? "unsupported"
    : !configured ? "inactive" : "waiting";
  const setupRequired = contract?.activationKinds?.some(kind => kind !== "native-service") === true;
  return { eligibility, configured, policy, runtime, modes, reasonCode: native.reasonCode ?? null,
    minimumVersion: native.eligibility?.minimumVersion ?? null,
    policySource: contract?.policySource ?? null,
    activation: !setupRequired ? "not_required"
      : activation?.mechanisms?.length > 0 ? "recorded" : "missing", sessionPolicy: null };
}

// Native runtime is workspace-specific. A hook-only binding cannot prove it;
// legacy launch policies may outlive the policy selected for future launches.
export function updateNativeRuntime(adapters, bindings) {
  const byAdapter = new Map();
  for (const binding of bindings ?? []) {
    if (!binding.availableModes?.includes("livePush")) continue;
    const previous = byAdapter.get(binding.adapterId);
    if (previous === undefined || binding.reachable) byAdapter.set(binding.adapterId, binding);
  }
  for (const entry of adapters) {
    const native = entry.nativeDelivery;
    if (native.eligibility === "unsupported") continue;
    const binding = byAdapter.get(entry.adapterId);
    const disabled = native.policySource === "installation-record" && !native.configured;
    native.runtime = disabled ? "inactive"
      : binding === undefined ? (native.configured ? "waiting" : "inactive")
        : binding.reachable ? "active" : "degraded";
    native.sessionPolicy = disabled || !binding ? null
      : native.policySource === "installation-record" ? native.policy : binding.livePolicy;
    if (binding) native.modes = binding.availableModes.filter(mode => mode !== "nextTurn");
  }
}
