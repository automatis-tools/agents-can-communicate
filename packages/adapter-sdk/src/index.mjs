// Capability contract, context projection, config ownership, and the binding
// that survives between two ephemeral hook processes.
export { CAPABILITY_SHAPE, assertCapabilities, defineAdapter } from "./capabilities.mjs";
export { capabilityEvidence, compareVersionOrder, effectiveCapabilities, validateCertification,
  versionOrder }
  from "./certification.mjs";
export { NATIVE_ACTIVATION_KINDS, NATIVE_BINDING_MODES, NATIVE_REASON_CODES,
  compareStableVersions, evaluateNativeEligibility, evaluateVersionContract, isLaunchOption,
  parseStableVersion,
  validateNativeActivationPlan, validateNativeDeliveryContract, validateNativeHandshake }
  from "./native-delivery.mjs";
export { EVENT_KINDS, NORMALIZED_EVENT_KEYS, normalizedEvent } from "./events.mjs";
export { assertRunner, bakeSkillCommand, defaultAntigravityRelay, defaultCli, isShellWord,
  defaultRunner, removeInstalledTree, runnerExists, shellQuote, writeCliShim, writeHookShim }
  from "./hook-shim.mjs";
export { BEGIN, END, removeTomlBlock, renderBlock, stripBlock, tomlString, writeTomlBlock }
  from "./toml-block.mjs";
export { projectContext, projectContextResult } from "./context-projector.mjs";
export { decisionBody, decisionLines } from "./decision-text.mjs";
export { shellWriteTargets } from "./shell-writes.mjs";
export { keepVersions, ownVersion, stampPluginVersion } from "./own-version.mjs";
export { editJson, readJson } from "./json-text.mjs";
export { formatJsonAs, jsonStyleOf, mergeOwnedConfig, mergeOwnedEntries, ownedEntries, ownedKeys,
  acccreatedFile, removeIfEmpty, removeOwnedConfig, removeOwnedEntries, writeForeignJson,
  blankJson, blankText } from "./config-merge.mjs";
export { clearSessionBinding, listSessionBindings, loadSessionBinding,
  storeSessionBinding }
  from "./session-binding.mjs";

export { clearNativeAttempt, loadNativeAttempt, storeNativeAttempt } from "./native-attempt.mjs";
export { channelSocketDirectory } from "./channel-directory.mjs";
export { readProcessArgs, readProcessTable, splitWindowsCommandLine } from "./process-table.mjs";
export { npmShimTarget, resolveExecutable, runExecutable } from "./executables.mjs";
export { pathOf } from "./executables.mjs";
export { windowsHookCommand } from "./windows-command.mjs";
export { shortPath } from "./windows-command.mjs";
export { mergeEnv } from "./executables.mjs";
export { closedTo, isWindowsPlatform, openRegularNoFollow } from "./private-files.mjs";
