import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";

import { defaultBootstrap } from "@agents-can-communicate/adapter-sdk";

import { installShellBootstrap, planShellBootstrap, uninstallShellBootstrap }
  from "./shell-bootstrap.mjs";

// The installer's side of a native activation: which owned mechanisms an
// eligible adapter asked for, how they are applied in a fixed order, what is
// recorded so uninstall removes only ACC's bytes, and how a recorded
// activation is taken back. Adapter-owned native config is written by the
// adapter's own install; a vendor service is started only here, only during
// apply, and only when it did not already exist.

export const LIVE_POLICIES = Object.freeze(["off", "actionable", "all"]);
const MECHANISM_ORDER = ["native-config", "native-service", "shell-bootstrap"];
const SERVICE_TIMEOUT_MS = 15_000;

export const livePolicyOf = install => (LIVE_POLICIES.includes(install?.nativeActivation?.livePolicy)
  ? install.nativeActivation.livePolicy : "off");

export const shellOf = env => {
  const shell = env?.SHELL;
  return typeof shell === "string" && shell !== "" ? path.basename(shell) : null;
};
export const shimDirFor = stateRoot => path.join(stateRoot, "bin");
// `.zshrc`, deliberately, and that makes the shim interactive-only: zsh reads
// this file for interactive shells and not for `zsh -lc` or a script. An
// interactive launch is where a client session comes from, and putting the PATH
// entry somewhere every shell reads would put ACC in front of a vendor command
// in scripts and CI that never asked for it. Worth knowing when checking an
// install: a non-interactive shell resolving the vendor binary directly is this
// choice working, not a broken bootstrap.
export const rcFileFor = (home, shell) => (shell === "zsh" && typeof home === "string"
  ? path.join(home, ".zshrc") : null);

// The vendor executable a shim will exec: the first executable on PATH that is
// not ACC's own shim directory, so a shim never resolves itself.
export async function resolveExecutable(command, { pathEnv = "", exclude = [] } = {}) {
  const excluded = exclude.filter(Boolean).map(directory => path.resolve(directory));
  for (const directory of String(pathEnv).split(path.delimiter).filter(Boolean)) {
    if (excluded.includes(path.resolve(directory))) continue;
    const candidate = path.join(directory, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here; keep walking PATH
    }
  }
  return null;
}

const defaultExec = (executable, args) => new Promise((resolve, reject) => {
  execFile(executable, args, { timeout: SERVICE_TIMEOUT_MS, windowsHide: true },
    error => (error === null ? resolve() : reject(error)));
});

const ordered = mechanisms => [...mechanisms].sort((left, right) =>
  MECHANISM_ORDER.indexOf(left.kind) - MECHANISM_ORDER.indexOf(right.kind));

const renderCommand = command => [command.executable, ...command.args].join(" ");

/** What an activation would touch, in the operator's words. */
export function describeActivation(activation) {
  const lines = [];
  for (const mechanism of ordered(activation.mechanisms)) {
    if (mechanism.kind === "shell-bootstrap") {
      lines.push(`create shim ${path.join(activation.shimDir, mechanism.command)} for `
        + `${mechanism.command} (${activation.livePolicy} live delivery)`);
      lines.push(`add a PATH block to ${activation.rcFile}`);
    } else if (mechanism.kind === "native-config") {
      lines.push(`write native config ${mechanism.artifactIds.join(", ")}`);
    } else if (mechanism.preExisting) {
      lines.push(`use the existing ${mechanism.serviceId} service`);
    } else if (mechanism.applyCommand !== null) {
      lines.push(`start the ${mechanism.serviceId} service: ${renderCommand(mechanism.applyCommand)}`);
    }
  }
  return lines;
}

export function describeDeactivation(nativeActivation) {
  const lines = [];
  for (const mechanism of nativeActivation?.mechanisms ?? []) {
    if (mechanism.kind === "shell-bootstrap") {
      for (const file of mechanism.ownedFiles) lines.push(`remove shim ${file.path}`);
      lines.push(`remove the PATH block from ${mechanism.rcFile.path} once no ACC shim remains`);
    } else if (mechanism.kind === "native-service") {
      lines.push(mechanism.createdByAcc && mechanism.teardownCommand !== null
        ? `stop the ${mechanism.serviceId} service: ${renderCommand(mechanism.teardownCommand)}`
        : `leave the ${mechanism.serviceId} service in place (${mechanism.createdByAcc
          ? "no vendor teardown exists" : "it existed before ACC"})`);
    }
  }
  return lines;
}

export async function applyNativeActivation({ adapter, activation, dataHome,
  node = process.execPath, bootstrap = defaultBootstrap(), exec = defaultExec }) {
  const record = { livePolicy: activation.livePolicy,
    protocolContract: activation.protocolContract, mechanisms: [] };
  let shell = null;
  try {
    for (const mechanism of ordered(activation.mechanisms)) {
      if (mechanism.kind === "native-config") {
        record.mechanisms.push({ kind: mechanism.kind, artifactIds: [...mechanism.artifactIds] });
      } else if (mechanism.kind === "native-service") {
        let createdByAcc = false;
        if (!mechanism.preExisting && mechanism.applyCommand !== null) {
          await exec(mechanism.applyCommand.executable, mechanism.applyCommand.args);
          createdByAcc = true;
        }
        record.mechanisms.push({ kind: mechanism.kind, serviceId: mechanism.serviceId,
          createdByAcc, teardownCommand: mechanism.teardownCommand });
      } else {
        const plan = planShellBootstrap({ shell: activation.shell, rcFile: activation.rcFile,
          shimDir: activation.shimDir, runtime: { node, bootstrap, dataHome },
          entries: [{ adapterId: adapter.id, command: mechanism.command,
            realExecutable: mechanism.realExecutable, prefixArgs: mechanism.prefixArgs,
            livePolicy: activation.livePolicy }] });
        const result = await installShellBootstrap({ plan });
        if (!result.ok) throw new Error(`shell bootstrap refused: ${result.reasonCode}`);
        shell = result;
        record.mechanisms.push({ kind: mechanism.kind, shimDir: activation.shimDir,
          ownedFiles: result.shims.map(shim => ({ path: shim.path, sha256: shim.sha256 })),
          rcFile: result.rcFile });
      }
    }
    return { nativeActivation: record, appendedRcBlock: shell?.rcFile.appended === true };
  } catch (error) {
    // Only bytes this operation wrote are taken back; a pre-existing service
    // or a user's own file is never touched on the way out.
    if (shell !== null) {
      await uninstallShellBootstrap({ ownership: { shims: shell.shims, shimDir: activation.shimDir,
        rcFile: shell.rcFile } }).catch(() => null);
    }
    throw error;
  }
}

export async function deactivateNative({ nativeActivation, exec = defaultExec }) {
  const report = { shell: null, services: [] };
  for (const mechanism of nativeActivation?.mechanisms ?? []) {
    if (mechanism.kind === "shell-bootstrap") {
      report.shell = await uninstallShellBootstrap({ ownership: { shims: mechanism.ownedFiles,
        shimDir: mechanism.shimDir, rcFile: mechanism.rcFile } });
    } else if (mechanism.kind === "native-service") {
      if (mechanism.createdByAcc && mechanism.teardownCommand !== null) {
        await exec(mechanism.teardownCommand.executable, mechanism.teardownCommand.args);
        report.services.push({ serviceId: mechanism.serviceId, outcome: "stopped" });
      } else {
        report.services.push({ serviceId: mechanism.serviceId,
          outcome: mechanism.createdByAcc ? "retained_no_teardown" : "retained_pre_existing" });
      }
    }
  }
  return report;
}
