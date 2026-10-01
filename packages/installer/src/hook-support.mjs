// What a hook reads from the installation record, without the installer: the
// package index loads detection, planning and application, which a hook never
// runs, on every turn.
export { loadOwnership } from "./ownership.mjs";
export { readInstalledLivePolicyState } from "./live-policy.mjs";
