import { defineAdapter, projectContext, projectContextResult }
  from "@agents-can-communicate/adapter-sdk";
import certification from "../certification.json" with { type: "json" };

import { denyOutcome, injectOutcome, normalizeAntigravityHook, stopOutcome } from "./hooks.mjs";
import { detectAntigravity, doctorAntigravity, installAntigravity, planAntigravityInstall,
  preflightAntigravityUninstall, uninstallAntigravity } from "./install.mjs";
import { bindNativeSession, nativeActivationHint, offerMessage, planNativeActivation,
  probeNativeDelivery, refreshNativeSession } from "./native-delivery.mjs";
import { PROTOCOL_CONTRACT } from "./relay-endpoint.mjs";

// The version this client has been captured on, and the floor of what is
// certified: nothing earlier was measured, and later releases - this client
// ships every few days - are judged by this capture until one of their own
// says otherwise.
export const ANTIGRAVITY_CLI_VERSION = "1.2.7";

/**
 * Antigravity CLI.
 *
 * Four things are declared true and they are the four a capture in this
 * package shows. Everything else is false, and most of it is false because the
 * event it would need does not exist here rather than because it was not tried.
 *
 * This client shares `~/.gemini` with Gemini CLI and reads none of the same
 * configuration. Its hooks are namespaced by integration, its event names are
 * its own, and the shape ACC writes for Gemini CLI - a flat event map carrying
 * `matcher` and a nested `hooks` array - parses here and registers nothing at
 * all. The two adapters therefore share a directory and no code path: install,
 * uninstall and doctor here must leave `~/.gemini/settings.json` and
 * `~/.gemini/extensions/agents-can-communicate` byte-identical.
 *
 * What is not here matters as much as what is:
 *
 * - **No tool guard.** `PreToolUse` and `PostToolUse` are accepted into the
 *   config file and never fire. `matcher` inside the action, `matcher` as a
 *   nested key and a `tool` field were each tried; none loaded. There is no
 *   `guards.beforeWrite` equivalent, and simulating one from `PreInvocation`
 *   would claim protection this client cannot deliver.
 * - **No session end.** `SessionEnd` is accepted and never fires, so a
 *   participant cannot be deregistered from a lifecycle event. Sessions here
 *   go offline by presence age or by an explicit `acc finish`, and that is a
 *   stated limitation rather than something inferred quietly.
 * - **Live push through the agent's own shell.** The session endpoint that
 *   `agy agentapi send-message` needs exists only in the agent's tool shell,
 *   so the agent starts ACC's relay once per conversation; the relay keeps the
 *   endpoint in memory and pushes each peer message as a system message. Print
 *   mode ends with its turn and gets none, and neither does the first session
 *   in a folder trusted at that launch, whose hooks see no workspace.
 *   `delivery.replyRoute` stays false: the reply is the ordinary `acc reply`.
 *
 * The end-of-turn `Stop` continuation is real and was measured, and it is
 * deliberately not sold as a gate. Vendor 1.1.9 caps consecutive continuations,
 * so an adapter that leaned on it would eventually be overruled without notice.
 * This one imposes its own ceiling of a single continuation and fails open on
 * every other path - see `stopResponse` in `hooks.mjs`.
 */
export function createAntigravityAdapter() {
  return defineAdapter({
    id: "antigravity",
    displayName: "Antigravity CLI",
    // What the official installer puts on PATH, and what a version probe has to
    // spawn: `agy --version` answers `1.2.7`. Presence liveness also walks the
    // hook's process ancestry for this basename to learn the client's own pid.
    client: { command: "agy", certificationName: "antigravity-cli",
      versionArgs: ["--version"] },
    certification,
    certificationFloor: { "darwin-arm64": ANTIGRAVITY_CLI_VERSION },
    capabilities: {
      lifecycle: { sessionStart: true },
      context: { beforeTurnInjection: true },
      delivery: { nextTurn: true, livePush: true },
    },
    // Live delivery runs through a relay the agent starts once per conversation
    // from its own shell - the only process holding the session endpoint. The
    // relay owns its registration and retires itself with its agy, so there is
    // no retireNativeSession here: the hook runner retires and re-publishes the
    // binding on every turn, and must not take the relay with it.
    nativeDelivery: {
      minimumByPlatform: { "darwin-arm64": ANTIGRAVITY_CLI_VERSION },
      anchors: [{ platform: "darwin-arm64", version: ANTIGRAVITY_CLI_VERSION,
        protocolContract: PROTOCOL_CONTRACT }],
      knownBad: [], activationKinds: ["native-config"], policySource: "installation-record",
    },
    probeNativeDelivery, planNativeActivation, bindNativeSession, refreshNativeSession,
    offerMessage,
    deliveryFallback: { diagnostic:
      `Antigravity CLI next-turn and live delivery are certified for ${ANTIGRAVITY_CLI_VERSION} and `
      + "later stable releases on darwin-arm64; live delivery also needs the agent to start "
      + "ACC's relay once per conversation, and every other case keeps durable acc inbox access" },

    startSession: async () => ({ ok: true, changes: [], diagnostics: [] }),

    planInstall: context => planAntigravityInstall(context),
    detect: context => detectAntigravity(context),
    install: context => installAntigravity(context),
    uninstall: context => uninstallAntigravity(context),
    preflightUninstall: context => preflightAntigravityUninstall(context),
    doctor: context => doctorAntigravity(context),

    denyOutcome,
    injectOutcome,
    // How the hook runner holds a turn open when a peer message arrived while
    // the model was producing its last answer. The count it is bounded by is
    // the client's own `executionNum`, read from the Stop payload the runner
    // hands back: 0 on the first Stop of a turn, 1 after one continuation.
    continueTurnOutcome: ({ reason, payload }) => stopOutcome({ reason,
      executionNum: payload?.executionNum }),
    // The one line that asks the agent to start live delivery for its
    // conversation. The runner asks for it only when the native binding is
    // degraded: the live policy is on and no relay serves this conversation.
    nativeActivationHint,
    // The event name is the second argument, because this client's payload does
    // not carry one and two of its four events are byte-identical.
    normalizeHook: (payload, options) => normalizeAntigravityHook(payload, options),
    renderContext: (sync, options) => projectContext(sync, options),
    renderContextResult: (sync, options) => projectContextResult(sync, options),
  });
}
