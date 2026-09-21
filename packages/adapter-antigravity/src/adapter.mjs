import { defineAdapter, projectContext, projectContextResult }
  from "@agents-can-communicate/adapter-sdk";
import certification from "../certification.json" with { type: "json" };

import { denyOutcome, injectOutcome, normalizeAntigravityHook, stopOutcome } from "./hooks.mjs";
import { detectAntigravity, doctorAntigravity, installAntigravity, planAntigravityInstall,
  preflightAntigravityUninstall, uninstallAntigravity } from "./install.mjs";
import { nativeActivationHint } from "./native-delivery.mjs";

// The one version this client has been captured on. There is no earlier tier:
// this package's first capture is 1.2.7, and a version that has not been
// measured is certified for nothing.
export const ANTIGRAVITY_CLI_VERSION = "1.2.7";

/**
 * Antigravity CLI.
 *
 * Three things are declared true and they are the three a capture in this
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
 * - **No live push.** `agy agentapi send-message` exists as a hidden
 *   subcommand and nothing about it has been captured; no `agentapi` binary
 *   exists under `~/.gemini/antigravity-cli/bin/`. `delivery.livePush` and
 *   `delivery.replyRoute` stay false.
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
    capabilities: {
      lifecycle: { sessionStart: true },
      context: { beforeTurnInjection: true },
      delivery: { nextTurn: true },
    },
    deliveryFallback: { diagnostic:
      `Antigravity CLI next-turn delivery is certified only for ${ANTIGRAVITY_CLI_VERSION} `
      + "on darwin-arm64; other or unknown versions keep durable acc inbox access, and live "
      + "push is unavailable on every version" },

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
    // degraded, which needs a native contract: until one is certified every
    // binding here is unsupported and this is never called.
    nativeActivationHint,
    // The event name is the second argument, because this client's payload does
    // not carry one and two of its four events are byte-identical.
    normalizeHook: (payload, options) => normalizeAntigravityHook(payload, options),
    renderContext: (sync, options) => projectContext(sync, options),
    renderContextResult: (sync, options) => projectContextResult(sync, options),
  });
}
