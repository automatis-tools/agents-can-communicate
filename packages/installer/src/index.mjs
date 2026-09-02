// Detection, planning, application, and the record of what was installed.
export { detectInstallation, spawnProbe } from "./detect.mjs";
export { planInstallation } from "./plan.mjs";
export { applyPlan } from "./apply.mjs";
export { finalizeRemoval, fingerprint, loadOwnership, missingArtifactParents, recordInstall,
  removeEmptyOwnedDirectories, removeOwned, removeOwnedArtifacts, treeFingerprint, verifyOwned }
  from "./ownership.mjs";
