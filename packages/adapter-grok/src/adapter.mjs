import { defineAdapter, projectContext, projectContextResult }
  from "@agents-can-communicate/adapter-sdk";
import certification from "../certification.json" with { type: "json" };

import { denyOutcome, injectOutcome, normalizeGrokHook } from "./hooks.mjs";
import { planGrokInstall, detectGrok, installGrokHooks, uninstallGrokHooks, grokHomeOf }
  from "./install.mjs";

const forClient = context => ({ ...context, grokHome: grokHomeOf(context) });

export const GROK_VERSION = "1.0.13";

/**
 * Independent Grok adapter. It writes only under this client's own directory
 * (`~/.grok` by default). It does not read or write `~/.claude`.
 *
 * Every true capability below was observed in a real Grok 1.0.13 TUI session.
 * Fixtures match the published stdin envelope; TUI logs recorded event names and
 * success, not the full payload. What stays false, and why, is in
 * COMPATIBILITY.md.
 */
export function createGrokAdapter() {
  return defineAdapter({
    id: "grok",
    displayName: "Grok",
    // Native Mach-O at ~/.grok/bin/grok. `ps -o comm=` on 1.0.13 reports `grok`.
    client: { command: "grok", certificationName: "grok", versionArgs: ["--version"] },
    certification,
    // The shipped JSON shapes were copied from documentation. Session logs
    // prove some event names fired, but those captures are not package-shipped,
    // so no effective capability is certified from them.
    capabilities: {},

    startSession: async () => ({ ok: true, changes: [], diagnostics: [] }),
    endSession: async () => ({ ok: true, changes: [], diagnostics: [] }),

    planInstall: context => planGrokInstall(forClient(context)),
    detect: context => detectGrok(forClient(context)),
    install: context => installGrokHooks(forClient(context)),
    uninstall: context => uninstallGrokHooks(forClient(context)),

    doctor: async context => {
      const detected = await detectGrok(forClient(context));
      return { ok: true, changes: [], diagnostics: [
        ...detected.diagnostics,
        `hook events observed on Grok ${GROK_VERSION} TUI`,
        "UserPromptSubmit additionalContext is discarded; agents read acc status / inbox",
        "write and shell guards are wired but not yet captured denying a real call",
        "install writes ~/.grok only; Claude Code is a separate adapter",
      ] };
    },

    denyOutcome,
    injectOutcome,
    normalizeHook: payload => normalizeGrokHook(payload),
    renderContext: (sync, options) => projectContext(sync, options),
    renderContextResult: (sync, options) => projectContextResult(sync, options),
  });
}
