// Detection, planning, application, and the record of what was installed.
export { detectInstallation, spawnProbe } from "./detect.mjs";
export { planInstallation } from "./plan.mjs";
export { applyPlan } from "./apply.mjs";
export { finalizeRemoval, fingerprint, loadOwnership, missingArtifactParents, recordInstall,
  removeEmptyOwnedDirectories, removeOwned, removeOwnedArtifacts, treeFingerprint, verifyOwned }
  from "./ownership.mjs";
export { BLOCK_BEGIN, BLOCK_END, SHIM_MARKER, locateBlock, uninstallShellBootstrap }
  from "./shell-bootstrap.mjs";
export { LIVE_POLICIES, describeActivation, describeDeactivation, livePolicyOf,
  resolveExecutable, shimDirFor } from "./native-activation.mjs";
export { readInstalledLivePolicy, readInstalledLivePolicyState } from "./live-policy.mjs";
export { describeDeliveryFallback, describeInstallDelivery, describeNativeReason }
  from "./delivery-diagnostics.mjs";
