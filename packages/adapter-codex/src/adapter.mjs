import { defineAdapter, projectContext, projectContextResult }
  from "@agents-can-communicate/adapter-sdk";
import certification from "../certification.json" with { type: "json" };

import { allowOutcome, denyOutcome, injectOutcome, normalizeCodexHook }
  from "./hooks.mjs";
import { planCodexInstall, detectCodex, installCodexPlugin, uninstallCodexPlugin } from "./install.mjs";

export const CODEX_VERSION = "0.147.0";
export const CODEX_DELIVERY_FALLBACK = Object.freeze({
  diagnostic: "Codex native delivery is off: the codex-cli 0.152.0 capture found the "
    + "app-server control socket absent; ACC did not start a daemon or target session; "
    + "durable fallback remains exact-certified next-turn delivery or acc inbox",
});

/**
 * Each true capability was observed firing in a real codex exec session on
 * 0.147.0; the payloads are in fixtures/ and the evidence is in
 * COMPATIBILITY.md.
 *
 * What stays false and why. `lifecycle.childSessions` is unverified:
 * SubagentStart and SubagentStop are in the binary's enum but no subagent ran
 * during the capture. Native live delivery and reply routing remain false after
 * the 0.152.0 capture found no existing app-server control socket.
 */
export function createCodexAdapter() {
  return defineAdapter({
    id: "codex",
    displayName: "Codex CLI",
    // The binary this client actually installs. Probed for a version to
    // decide whether the client is on this machine, so it has to be the
    // real command rather than the adapter id: `codex-cli 0.147.0`.
    client: { command: "codex", certificationName: "codex-cli", versionArgs: ["--version"] },
    certification,
    deliveryFallback: CODEX_DELIVERY_FALLBACK,
    capabilities: {
      lifecycle: { sessionStart: true, sessionEnd: true },
      // Observed reaching the model as a `developer` role message, unwrapped.
      context: { beforeTurnInjection: true },
      // PreToolUse was observed blocking both a shell command and an
      // apply_patch edit, with the reason reaching the model verbatim.
      // The captured Bash payload is an allowed PostToolUse event, not the
      // denied PreToolUse capture required to certify a shell guard.
      guards: { beforeWrite: true },
      delivery: { nextTurn: true },
    },

    startSession: async () => ({ ok: true, changes: [], diagnostics: [] }),
    endSession: async () => ({ ok: true, changes: [], diagnostics: [] }),
    guardWrite: async () => ({ ok: true, changes: [], diagnostics: [] }),
    guardShell: async () => ({ ok: true, changes: [], diagnostics: [] }),

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
          CODEX_DELIVERY_FALLBACK.diagnostic,
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
          // Was a standing sentence here, true and useless: it said the same
          // thing on a machine whose hooks were trusted, on one whose were not,
          // and on one with nothing installed. Detection reads the client's own
          // record now and speaks only when it has something to report.
        ],
      };
    },

    denyOutcome,
    allowOutcome,
    injectOutcome,
    normalizeHook: payload => normalizeCodexHook(payload),
    renderContext: (sync, options) => projectContext(sync, options),
    renderContextResult: (sync, options) => projectContextResult(sync, options),
  });
}
