import { defineAdapter, projectContext, projectContextResult }
  from "@agents-can-communicate/adapter-sdk";
import { probeNativeDelivery, planNativeActivation, bindNativeSession, refreshNativeSession, retireNativeSession, offerMessage } from "./native-delivery.mjs";
import certification from "../certification.json" with { type: "json" };
import { createCodexMaintenance } from "./maintenance.mjs";
export { sameMaintenanceIdentity } from "./maintenance.mjs";

import { CODEX_QUEUE_MINIMUM, PROTOCOL_CONTRACT } from "./app-server-client.mjs";
import { allowOutcome, denyOutcome, injectOutcome, normalizeCodexHook }
  from "./hooks.mjs";
import { planCodexInstall, detectCodex, installCodexPlugin, preflightCodexUninstall,
  uninstallCodexPlugin } from "./install.mjs";
// Public native wiring is enabled only with installed-product capture evidence.

// Re-exported so existing importers of CODEX_QUEUE_MINIMUM keep resolving; the
// value now lives in app-server-client.mjs alongside the other version rules.
export { CODEX_QUEUE_MINIMUM };
export const CODEX_VERSION = "0.147.0";
export const CODEX_DELIVERY_FALLBACK = Object.freeze({
  diagnostic: "Codex native delivery requires codex-cli 0.152.1 or newer on darwin-arm64, "
    + "recorded recipient consent and a reachable LocalDaemon session with exact thread, cwd, "
    + "process, version and protocol verification. Embedded or unreachable sessions retain "
    + "durable messages. Native delivery does not start, restart or stop the vendor daemon and adds no "
    + "launch arguments; fallback is exact-certified next-turn delivery or acc inbox. "
    + "Explicitly confirmed acc update maintenance has a separate daemon restart check",
});

/**
 * Each true capability was observed firing in a real codex exec session on
 * 0.147.0; the payloads are in fixtures/ and the evidence is in
 * COMPATIBILITY.md.
 *
 * Native delivery has its own installed-client evidence and runtime handshake.
 * Child sessions, native reply routing and new hook-version claims remain
 * unverified; a successful ACC CLI reply does not certify a native reply route.
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
      // nextTurn remains limited to its exact 0.147.0 hook capture.
      delivery: { nextTurn: true, livePush: true },
    },
    // Native acceleration is a separate, per-session eligibility decision.

    nativeDelivery: {
      minimumByPlatform: { "darwin-arm64": CODEX_QUEUE_MINIMUM },
      anchors: [{ platform: "darwin-arm64", version: CODEX_QUEUE_MINIMUM,
        protocolContract: PROTOCOL_CONTRACT }], knownBad: [],
      activationKinds: ["native-service"], policySource: "installation-record",
    },
    probeNativeDelivery, planNativeActivation, bindNativeSession,
    refreshNativeSession, retireNativeSession, offerMessage,
    ...createCodexMaintenance(),
    startSession: async () => ({ ok: true, changes: [], diagnostics: [] }),
    endSession: async () => ({ ok: true, changes: [], diagnostics: [] }),
    guardWrite: async () => ({ ok: true, changes: [], diagnostics: [] }),
    guardShell: async () => ({ ok: true, changes: [], diagnostics: [] }),


    planInstall: context => planCodexInstall(context),
    detect: context => detectCodex(context),
    install: context => installCodexPlugin({ ...context,
      livePolicy: context.livePolicy ?? "off" }),
    preflightUninstall: context => preflightCodexUninstall(context),
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
          // Installed files and certification do not verify this user's current
          // hook enablement/trust. Detection directs that check to the client.
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
