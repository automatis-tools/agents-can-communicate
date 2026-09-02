// Detection, planning, application, and the record of what was installed.
export { detectInstallation, spawnProbe } from "./detect.mjs";
export { planInstallation } from "./plan.mjs";
export { applyPlan } from "./apply.mjs";
export { finalizeRemoval, fingerprint, loadOwnership, missingArtifactParents, recordInstall,
  removeEmptyOwnedDirectories, removeOwned, removeOwnedArtifacts, treeFingerprint, verifyOwned }
  from "./ownership.mjs";
export { BOOTSTRAP_CACHE_SCHEMA, FAILED_TTL_MS, SUPPORTED_TTL_MS, cachePathFor,
  checkNativeBootstrap } from "./bootstrap-runtime.mjs";
export { BLOCK_BEGIN, BLOCK_END, SHIM_MARKER, SHIM_POLICIES, SUPPORTED_SHELLS,
  installShellBootstrap, locateBlock, planShellBootstrap, renderCommandShim, renderPathBlock,
  shellLiteral, uninstallShellBootstrap, validateShimEntry } from "./shell-bootstrap.mjs";
