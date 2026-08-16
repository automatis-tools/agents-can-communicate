import { defineAdapter, projectContext } from "@agents-can-communicate/adapter-sdk";

import { normalizeCodexHook } from "./hooks.mjs";
import { detectCodex, installCodexPlugin, uninstallCodexPlugin } from "./install.mjs";

export const CODEX_VERSION = "0.147.0";

/**
 * Every capability is false, deliberately.
 *
 * The hook events exist - they are an enum in the installed binary - but no
 * published or bundled material describes what a hook receives on stdin, and no
 * payload has been observed from a real session yet. Enum membership proves an
 * event fires; it does not prove this adapter can handle it. Declaring
 * lifecycle or a guard on that basis would be exactly the overclaim
 * AGENTS.md forbids: a user would see "guarded" and believe their edits were
 * protected.
 *
 * Capabilities flip to true one at a time, each backed by a captured fixture
 * under fixtures/ and a conformance run against it.
 */
export function createCodexAdapter() {
  return defineAdapter({
    id: "codex",
    displayName: "Codex CLI",
    capabilities: {},

    detect: context => detectCodex(context),
    install: context => installCodexPlugin(context),
    uninstall: context => uninstallCodexPlugin(context),

    doctor: async context => {
      const detected = await detectCodex(context);
      const captured = context.fixtures?.length > 0;
      return {
        ok: captured,
        changes: [],
        diagnostics: [
          ...detected.diagnostics,
          captured
            ? "hook payloads captured"
            : "hook payloads not captured: no capability can be declared until a real "
              + "Codex session has been observed",
          "Codex requires hooks to be trusted before they run; an untrusted plugin is "
            + "installed but inert",
        ],
      };
    },

    normalizeHook: payload => normalizeCodexHook(payload),
    renderContext: sync => projectContext(sync),
  });
}
