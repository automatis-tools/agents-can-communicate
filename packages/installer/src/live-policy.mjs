import { loadOwnership } from "./ownership.mjs";

export const LIVE_POLICIES = Object.freeze(["off", "actionable", "all"]);

export const livePolicyOf = install => {
  if (Object.hasOwn(install ?? {}, "deliveryPolicy")) {
    return LIVE_POLICIES.includes(install.deliveryPolicy) ? install.deliveryPolicy : "off";
  }
  return LIVE_POLICIES.includes(install?.nativeActivation?.livePolicy)
    ? install.nativeActivation.livePolicy : "off";
};

export async function readInstalledLivePolicy(input) {
  return (await readInstalledLivePolicyState(input)).policy;
}

export async function readInstalledLivePolicyState({ dataHome, adapterId }) {
  try {
    const record = await loadOwnership({ dataHome });
    const install = record.installs.find(entry => entry.adapterId === adapterId);
    const raw = Object.hasOwn(install ?? {}, "deliveryPolicy")
      ? install.deliveryPolicy : install?.nativeActivation?.livePolicy;
    return { policy: livePolicyOf(install), policyStatus: raw === undefined ? "missing"
      : !LIVE_POLICIES.includes(raw) ? "invalid" : raw === "off" ? "off" : "enabled" };
  } catch {
    return { policy: "off", policyStatus: "unavailable" };
  }
}
