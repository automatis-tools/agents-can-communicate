import { loadOwnership } from "./ownership.mjs";

export const LIVE_POLICIES = Object.freeze(["off", "actionable", "all"]);

export const livePolicyOf = install => {
  if (Object.hasOwn(install ?? {}, "deliveryPolicy")) {
    return LIVE_POLICIES.includes(install.deliveryPolicy) ? install.deliveryPolicy : "off";
  }
  return LIVE_POLICIES.includes(install?.nativeActivation?.livePolicy)
    ? install.nativeActivation.livePolicy : "off";
};

export async function readInstalledLivePolicy({ dataHome, adapterId }) {
  try {
    const record = await loadOwnership({ dataHome });
    const install = record.installs.find(entry => entry.adapterId === adapterId);
    return livePolicyOf(install);
  } catch {
    return "off";
  }
}
