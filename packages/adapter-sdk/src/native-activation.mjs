import path from "node:path";

import { COMMAND_NAME, IDENTIFIER, NATIVE_ACTIVATION_KINDS, SHELL_SOURCE, assertReasonCode,
  closed, deepFreeze, isPlainObject, isText, usage } from "./native-vocabulary.mjs";

// A native activation plan is what an adapter hands the installer: closed
// mechanisms made of executables and argument arrays, never shell source. The
// generic installer records artifact ids and executes only the apply command
// of a native service, and only during apply.

function validateCommand(value, label) {
  if (value === null) return null;
  closed(value, ["executable", "args"], label);
  if (!isText(value.executable) || !path.isAbsolute(value.executable)) {
    usage(`${label} executable must be an absolute path`);
  }
  if (!Array.isArray(value.args) || value.args.some(arg => typeof arg !== "string"
    || SHELL_SOURCE.test(arg))) {
    usage(`${label} args must be plain argument strings, never shell source`);
  }
  return { executable: value.executable, args: [...value.args] };
}

function validateMechanism(mechanism, index) {
  const label = `native activation mechanism ${index}`;
  if (!isPlainObject(mechanism) || !NATIVE_ACTIVATION_KINDS.includes(mechanism.kind)) {
    usage(`${label} kind must be one of ${NATIVE_ACTIVATION_KINDS.join(", ")}`);
  }
  if (mechanism.kind === "shell-bootstrap") {
    closed(mechanism, ["kind", "command", "realExecutable", "prefixArgs"], label);
    if (!isText(mechanism.command) || !COMMAND_NAME.test(mechanism.command)) {
      usage(`${label} command must be a bare command name`);
    }
    if (!isText(mechanism.realExecutable) || !path.isAbsolute(mechanism.realExecutable)) {
      usage(`${label} realExecutable must be an absolute path`);
    }
    if (!Array.isArray(mechanism.prefixArgs) || mechanism.prefixArgs.some(arg => !isText(arg)
      || SHELL_SOURCE.test(arg))) {
      usage(`${label} prefixArgs must be plain argument strings, never shell source`);
    }
    return { kind: mechanism.kind, command: mechanism.command,
      realExecutable: mechanism.realExecutable, prefixArgs: [...mechanism.prefixArgs] };
  }
  if (mechanism.kind === "native-config") {
    closed(mechanism, ["kind", "artifactIds"], label);
    if (!Array.isArray(mechanism.artifactIds) || mechanism.artifactIds.length === 0
      || mechanism.artifactIds.some(id => !isText(id) || !IDENTIFIER.test(id))) {
      usage(`${label} artifactIds must be non-empty closed identifiers`);
    }
    return { kind: mechanism.kind, artifactIds: [...mechanism.artifactIds] };
  }
  closed(mechanism, ["kind", "serviceId", "preExisting", "applyCommand", "teardownCommand"], label);
  if (!isText(mechanism.serviceId) || !IDENTIFIER.test(mechanism.serviceId)) {
    usage(`${label} serviceId must be a closed identifier`);
  }
  if (typeof mechanism.preExisting !== "boolean") usage(`${label} preExisting must be a boolean`);
  const commandLabel = key => `${label} ${key} must be null or { executable, args }`;
  for (const key of ["applyCommand", "teardownCommand"]) {
    if (mechanism[key] !== null && !isPlainObject(mechanism[key])) usage(commandLabel(key));
  }
  return { kind: mechanism.kind, serviceId: mechanism.serviceId, preExisting: mechanism.preExisting,
    applyCommand: validateCommand(mechanism.applyCommand, `${label} applyCommand`),
    teardownCommand: validateCommand(mechanism.teardownCommand, `${label} teardownCommand`) };
}

export function validateNativeActivationPlan(value) {
  closed(value, ["eligible", "reasonCode", "mechanisms"], "native activation plan");
  if (typeof value.eligible !== "boolean") usage("native activation plan eligible must be a boolean");
  assertReasonCode(value.reasonCode, "native activation plan");
  if (!Array.isArray(value.mechanisms)) usage("native activation plan mechanisms must be an array");
  if (!value.eligible && value.mechanisms.length > 0) {
    usage("an ineligible native activation plan must not carry mechanisms");
  }
  return deepFreeze({ eligible: value.eligible, reasonCode: value.reasonCode,
    mechanisms: value.mechanisms.map(validateMechanism) });
}
