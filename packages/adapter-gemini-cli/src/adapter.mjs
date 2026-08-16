import { defineAdapter, projectContext } from "@agents-can-communicate/adapter-sdk";

import { normalizeGeminiHook } from "./hooks.mjs";
import { detectGemini, installGeminiExtension, uninstallGeminiExtension } from "./install.mjs";

export const GEMINI_CLI_VERSION = "0.37.0";

/**
 * Fewer capabilities than the other two adapters, and the reason is external.
 *
 * SessionStart, BeforeAgent, SessionEnd and PreCompress were observed firing
 * with real payloads. BeforeTool, AfterTool and AfterAgent are configurable and
 * accepted by the client, but never fired during the capture because the
 * account received HTTP 403 from the model API, so no turn ever ran. Guards and
 * injection therefore stay false: an event that is accepted in configuration is
 * not an event observed protecting anything.
 *
 * This is the honest gap, and it closes as soon as one turn completes on an
 * account that can reach the model.
 */
export function createGeminiCliAdapter() {
  return defineAdapter({
    id: "gemini_cli",
    displayName: "Gemini CLI",
    capabilities: {
      lifecycle: { sessionStart: true, sessionEnd: true },
      delivery: { polling: true },
    },

    startSession: async () => ({ ok: true, changes: [], diagnostics: [] }),
    endSession: async () => ({ ok: true, changes: [], diagnostics: [] }),
    poll: async () => ({ ok: true, changes: [], diagnostics: [] }),

    detect: context => detectGemini(context),
    install: context => installGeminiExtension(context),
    uninstall: context => uninstallGeminiExtension(context),

    doctor: async context => {
      const detected = await detectGemini(context);
      return { ok: true, changes: [], diagnostics: [
        ...detected.diagnostics,
        "lifecycle payloads captured from Gemini CLI 0.37.0",
        "BeforeTool was never observed firing, so no guard is declared; "
          + "the capture account received HTTP 403 from the model API",
      ] };
    },

    normalizeHook: payload => normalizeGeminiHook(payload),
    renderContext: sync => projectContext(sync),
  });
}
