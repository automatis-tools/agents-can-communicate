import { defineAdapter, projectContext } from "@agents-can-communicate/adapter-sdk";

import { denyOutcome, injectOutcome, normalizeKimiHook } from "./hooks.mjs";
import { planKimiInstall, detectKimi, installKimiPlugin, uninstallKimiPlugin } from "./install.mjs";

export const KIMI_CODE_VERSION = "0.36.1";

/**
 * The only adapter so far that can keep an idle session's presence honest.
 *
 * This client fires SessionHeartbeat on a timer - observed at 60002, 120004 and
 * 180006 ms of uptime, so a fixed 60s cadence. The other three reach a hook only
 * when the user takes a turn, so their sessions go stale while alive.
 *
 * The capture that proved the guards had to go around an exhausted account
 * quota: a local stand-in provider served one canned turn so the client itself
 * would really write a file and really run a shell command. The model was
 * stubbed; every hook payload here came from the client.
 *
 * sessionEnd stays false. It is in this client's event enum and was wired in
 * every capture run, and it never fired once - prompt mode exits without it.
 */
export function createKimiAdapter() {
  return defineAdapter({
    id: "kimi",
    displayName: "Kimi Code",
    capabilities: {
      lifecycle: { sessionStart: true, heartbeat: true },
      context: { beforeTurnInjection: true },
      guards: { beforeWrite: true, beforeShell: true },
      delivery: { polling: true },
    },

    startSession: async () => ({ ok: true, changes: [], diagnostics: [] }),
    heartbeat: async () => ({ ok: true, changes: [], diagnostics: [] }),
    guardWrite: async () => ({ ok: true, changes: [], diagnostics: [] }),
    guardShell: async () => ({ ok: true, changes: [], diagnostics: [] }),
    poll: async () => ({ ok: true, changes: [], diagnostics: [] }),

    planInstall: context => planKimiInstall(context),
    detect: context => detectKimi(context),
    install: context => installKimiPlugin(context),
    uninstall: context => uninstallKimiPlugin(context),

    doctor: async context => {
      const detected = await detectKimi(context);
      return { ok: true, changes: [], diagnostics: [
        ...detected.diagnostics,
        `lifecycle, guard and heartbeat payloads captured from Kimi Code ${KIMI_CODE_VERSION}`,
        "SessionHeartbeat fires every 60s, so presence stays accurate while idle",
        "SessionEnd is in this client's event enum but was never observed firing, "
          + "so the handoff must be written while the session is still working",
        "hook timeouts here are seconds, not milliseconds",
      ] };
    },

    denyOutcome,
    injectOutcome,
    normalizeHook: payload => normalizeKimiHook(payload),
    renderContext: (sync, options) => projectContext(sync, options),
  });
}
