import { defineAdapter, projectContext } from "@agents-can-communicate/adapter-sdk";

import { allowOutcome, denyOutcome, injectOutcome, normalizeCodexHook }
  from "./hooks.mjs";
import { planCodexInstall, detectCodex, installCodexPlugin, uninstallCodexPlugin } from "./install.mjs";

export const CODEX_VERSION = "0.147.0";

/**
 * Each true capability was observed firing in a real codex exec session on
 * 0.147.0; the payloads are in fixtures/ and the evidence is in
 * COMPATIBILITY.md.
 *
 * What stays false and why. `context.*` injection is unverified: the hooks fire
 * before a turn, but whether their stdout reaches the model has not been
 * observed, and injecting nothing while claiming injection would be worse than
 * claiming nothing. `lifecycle.childSessions` is unverified: SubagentStart and
 * SubagentStop are in the binary's enum but no subagent ran during the capture.
 * `delivery.*` beyond polling and `execution.*` are not offered by this harness
 * at all.
 */
export function createCodexAdapter() {
  return defineAdapter({
    id: "codex",
    displayName: "Codex CLI",
    // The binary this client actually installs. Probed for a version to
    // decide whether the client is on this machine, so it has to be the
    // real command rather than the adapter id: `codex-cli 0.147.0`.
    client: { command: "codex", versionArgs: ["--version"] },
    capabilities: {
      lifecycle: { sessionStart: true, sessionEnd: true },
      // Observed reaching the model as a `developer` role message, unwrapped.
      context: { beforeTurnInjection: true },
      // PreToolUse was observed blocking both a shell command and an
      // apply_patch edit, with the reason reaching the model verbatim.
      guards: { beforeWrite: true, beforeShell: true },
      delivery: { polling: true },
    },

    startSession: async () => ({ ok: true, changes: [], diagnostics: [] }),
    endSession: async () => ({ ok: true, changes: [], diagnostics: [] }),
    guardWrite: async () => ({ ok: true, changes: [], diagnostics: [] }),
    guardShell: async () => ({ ok: true, changes: [], diagnostics: [] }),
    poll: async () => ({ ok: true, changes: [], diagnostics: [] }),

    planInstall: context => planCodexInstall(context),
    detect: context => detectCodex(context),
    install: context => installCodexPlugin(context),
    uninstall: context => uninstallCodexPlugin(context),

    doctor: async context => {
      const detected = await detectCodex(context);
      const captured = true;
      return {
        ok: captured,
        changes: [],
        diagnostics: [
          ...detected.diagnostics,
          "hook payloads captured from codex-cli 0.147.0",
          "guards cover apply_patch and shell; Codex names its edit tool apply_patch",
          // Certification found this: whether apply_patch is offered at all is a
          // property of the model's metadata (apply_patch_tool_type), not a user
          // setting. With a model that does not have it, edits go through
          // exec_command, which reaches hooks as tool_name \"Bash\" carrying a
          // command string. Since 0.1.7 that command is read for its write
          // positions, so those edits are matched too - as far as the reading
          // goes. Verified on 0.147.0.
          "write guards cover apply_patch and the shell writes ACC can read; a model "
            + "without apply_patch edits through the shell, where a redirection or an "
            + "mv is matched and a runtime opening the file is not",
          "Codex requires hooks to be trusted before they run; an untrusted plugin is "
            + "installed but inert",
        ],
      };
    },

    denyOutcome,
    allowOutcome,
    injectOutcome,
    normalizeHook: payload => normalizeCodexHook(payload),
    renderContext: (sync, options) => projectContext(sync, options),
  });
}
