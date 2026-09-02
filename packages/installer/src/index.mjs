// Detection, planning, application, and the record of what was installed.
export { detectInstallation, spawnProbe } from "./detect.mjs";
export { planInstallation } from "./plan.mjs";
export { applyPlan } from "./apply.mjs";
export { fingerprint, loadOwnership, missingArtifactParents, recordInstall,
  removeEmptyOwnedDirectories, removeOwned, treeFingerprint, verifyOwned }
  from "./ownership.mjs";
