import { defineAdapter, projectContext, projectContextResult }
  from "@agents-can-communicate/adapter-sdk";
import certification from "../certification.json" with { type: "json" };

import { PROTOCOL_CONTRACT } from "./app-server-client.mjs";
import { allowOutcome, denyOutcome, injectOutcome, normalizeCodexHook }
  from "./hooks.mjs";
import { planCodexInstall, detectCodex, installCodexPlugin, uninstallCodexPlugin } from "./install.mjs";
// Nothing is imported from ./native-delivery.mjs on purpose. Its probe and bind
// still exist and still answer `workspace_identity_unavailable` for anything
// that reaches them directly, but this adapter wires none of it: an adapter that
// imports the four native methods and then declares no descriptor reads as
// half-withdrawn, and the launch-time check keys off the descriptor's absence.

export const CODEX_VERSION = "0.147.0";
export const CODEX_QUEUE_MINIMUM = "0.152.1";
// Says why native delivery is off, and this is read out by `acc doctor`, so it
// has to name the reason that actually applies. It used to name the 0.152.0
// capture's absent control socket, which stopped being the operative reason
// when 0.152.1 was withdrawn for a different and less fixable one - and reading
// it, an operator would go looking for a socket that is in fact there.
export const CODEX_DELIVERY_FALLBACK = Object.freeze({
  diagnostic: "Codex native delivery is off: measured on codex-cli 0.152.1, the mode it "
    + "requires runs the session inside the app-server daemon, which reports the "
    + "daemon's workspace rather than the session's, so ACC has no honest way to "
    + "address it - not a misconfiguration to repair; ACC did not start a daemon or "
    + "target session; durable fallback remains exact-certified next-turn delivery "
    + "or acc inbox",
});

/**
 * Each true capability was observed firing in a real codex exec session on
 * 0.147.0; the payloads are in fixtures/ and the evidence is in
 * COMPATIBILITY.md.
 *
 * What stays false and why. `lifecycle.childSessions` is unverified:
 * SubagentStart and SubagentStop are in the binary's enum but no subagent ran
 * during the capture. Native live delivery and reply routing are false for a
 * reason that outlived the 0.152.0 capture's absent control socket: on 0.152.1
 * the socket is there and the queue works, and the mode that reaches it hides
 * which workspace the session belongs to. See the note on the descriptor below.
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
      // nextTurn is the certified 0.147.0 hook projection. livePush rested on
      // the 0.152.1 App Server queue capture until the release capture withdrew
      // it: the transport works, but the mode it needs hides which workspace the
      // session is in, and a session ACC cannot place must not be addressed.
      delivery: { nextTurn: true, livePush: false },
    },
    // Native delivery is not declared. The contract is right to refuse a
    // descriptor with no passing anchor, and the release capture withdrew the
    // one this adapter had: the queue transport still works, but delivery here
    // requires `codex --remote unix://`, and in that mode neither the hook
    // payload's cwd nor the App Server's own thread record names the session's
    // directory - both name the daemon's. Measured on 0.152.1 with a client
    // working in one project and its thread recorded under another, ACC placed
    // the session in the wrong workspace and fed it that workspace's peers.
    //
    // Nothing ACC can reach carries the real workspace, so this is not a gap to
    // paper over with a default. Codex keeps next-turn delivery and the durable
    // inbox, which do not depend on knowing the session's directory.

    startSession: async () => ({ ok: true, changes: [], diagnostics: [] }),
    endSession: async () => ({ ok: true, changes: [], diagnostics: [] }),
    guardWrite: async () => ({ ok: true, changes: [], diagnostics: [] }),
    guardShell: async () => ({ ok: true, changes: [], diagnostics: [] }),


    planInstall: context => planCodexInstall(context),
    detect: context => detectCodex(context),
    install: context => installCodexPlugin({ ...context,
      livePolicy: context.livePolicy ?? "off" }),
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
