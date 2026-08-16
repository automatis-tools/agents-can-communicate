import { defineAdapter, projectContext } from "@agents-can-communicate/adapter-sdk";

import { allowOutcome, denyOutcome, normalizeCodexHook } from "./hooks.mjs";
import { detectCodex, installCodexPlugin, uninstallCodexPlugin } from "./install.mjs";

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
    capabilities: {
      lifecycle: { sessionStart: true, sessionEnd: true },
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
          "Codex requires hooks to be trusted before they run; an untrusted plugin is "
            + "installed but inert",
        ],
      };
    },

    denyOutcome,
    allowOutcome,
    normalizeHook: payload => normalizeCodexHook(payload),
    renderContext: sync => projectContext(sync),
  });
}
