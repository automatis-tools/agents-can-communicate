import { defineAdapter, projectContext } from "@agents-can-communicate/adapter-sdk";

import { denyOutcome, injectOutcome, normalizeGeminiHook } from "./hooks.mjs";
import { planGeminiInstall, detectGemini, installGeminiExtension, uninstallGeminiExtension } from "./install.mjs";

// Verified on both. The version jump changed how a session is authenticated and
// how a turn is routed, and changed neither the hook events nor either of the
// two response contracts.
export const GEMINI_CLI_VERSIONS = Object.freeze(["0.37.0", "0.55.1"]);
export const GEMINI_CLI_VERSION = "0.55.1";

/**
 * The gap this adapter used to carry is closed.
 *
 * BeforeTool, AfterTool and AfterAgent were undeclarable for a long time: the
 * capture account received HTTP 403 from the model API, so no turn ever ran and
 * no tool event fired. Pointing the client at a local stand-in endpoint with
 * GOOGLE_GEMINI_BASE_URL served one canned turn, and all three fired with real
 * payloads. Only the model was stubbed; the client really wrote the file and
 * really ran the shell command, and a deny really stopped each of them.
 *
 * The two contracts here disagree with each other, which is why both were
 * measured rather than assumed: a deny must be `{"decision":"block"}`, while an
 * injection must be the `hookSpecificOutput` envelope. Swapping them silently
 * does nothing at all.
 */
export function createGeminiCliAdapter() {
  return defineAdapter({
    id: "gemini_cli",
    displayName: "Gemini CLI",
    capabilities: {
      lifecycle: { sessionStart: true, sessionEnd: true },
      context: { beforeTurnInjection: true },
      guards: { beforeWrite: true, beforeShell: true },
      delivery: { polling: true },
    },

    startSession: async () => ({ ok: true, changes: [], diagnostics: [] }),
    endSession: async () => ({ ok: true, changes: [], diagnostics: [] }),
    guardWrite: async () => ({ ok: true, changes: [], diagnostics: [] }),
    guardShell: async () => ({ ok: true, changes: [], diagnostics: [] }),
    poll: async () => ({ ok: true, changes: [], diagnostics: [] }),

    planInstall: context => planGeminiInstall(context),
    detect: context => detectGemini(context),
    install: context => installGeminiExtension(context),
    uninstall: context => uninstallGeminiExtension(context),

    doctor: async context => {
      const detected = await detectGemini(context);
      return { ok: true, changes: [], diagnostics: [
        ...detected.diagnostics,
        `lifecycle, guard and injection payloads captured from Gemini CLI ${GEMINI_CLI_VERSIONS.join(" and ")}`,
        "a deny here must be {\"decision\":\"block\"}; the hookSpecificOutput shape "
          + "that Claude Code and Kimi Code accept does not deny on this client",
        "write guards need an approval mode that offers the edit tools; in plan "
          + "mode the client declares no write tool at all",
        // Both appeared with 0.55.1 and stop a headless session before any hook
        // beyond SessionStart can matter.
        "0.55.x needs an explicit security.auth.selectedType and a trusted "
          + "workspace; without either, a headless run stops before the first turn",
      ] };
    },

    denyOutcome,
    injectOutcome,
    normalizeHook: payload => normalizeGeminiHook(payload),
    renderContext: sync => projectContext(sync),
  });
}
