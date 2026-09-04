import { defineAdapter, projectContext, projectContextResult }
  from "@agents-can-communicate/adapter-sdk";
import certification from "../certification.json" with { type: "json" };

import { PROTOCOL_CONTRACT } from "./channel.mjs";
import { denyOutcome, injectOutcome, normalizeClaudeHook } from "./hooks.mjs";
import { planClaudeInstall, detectClaude, installClaudePlugin, uninstallClaudePlugin } from "./install.mjs";
import { bindNativeSession, offerMessage, planNativeActivation, probeNativeDelivery, routeReply }
  from "./native-delivery.mjs";

export const CLAUDE_CODE_VERSION = "2.1.233";
export const CLAUDE_CHANNEL_MINIMUM = "2.1.258";
export const CLAUDE_DELIVERY_FALLBACK = Object.freeze({
  diagnostic: "Claude Code native delivery is off: the 2.1.252 capture stopped at the "
    + "development-channel security warning before the ACC MCP child started; messages "
    + "stay durable for certified next-turn delivery or acc inbox",
});

/**
 * Every true capability below was observed in a real `claude -p` session on
 * 2.1.233; fixtures are in fixtures/ and the evidence is in COMPATIBILITY.md.
 *
 * What stays false and why. `childSessions` is unproven: SubagentStart and
 * SubagentStop are documented and real, but no subagent ran during the capture,
 * and a parent/child mapping claimed without observation is the kind of thing
 * that quietly maps every child onto its parent. `startupInjection` and
 * `safePointInjection` were not exercised - only the before-turn path was.
 * Native live delivery and reply routing are not certified for this harness.
 */
export function createClaudeCodeAdapter() {
  return defineAdapter({
    id: "claude_code",
    displayName: "Claude Code",
    // The binary this client actually installs. Probed for a version to
    // decide whether the client is on this machine, so it has to be the
    // real command rather than the adapter id: `2.1.233 (Claude Code)`.
    client: { command: "claude", certificationName: "claude-code", versionArgs: ["--version"] },
    certification,
    deliveryFallback: CLAUDE_DELIVERY_FALLBACK,
    capabilities: {
      lifecycle: { sessionStart: true, sessionEnd: true },
      // A UserPromptSubmit hook's additionalContext was observed arriving in
      // the session, and the model treated it as data rather than instruction.
      context: { beforeTurnInjection: true },
      // PreToolUse denied both a Write and a Bash call; neither ran.
      guards: { beforeWrite: true, beforeShell: true },
      // nextTurn is the certified 2.1.233 hook projection; livePush and
      // replyRoute rest on the 2.1.258 Channel capture and the native contract
      // below. effectiveCapabilities() still gates every row on an exact
      // certified version; the native contract is the separate live rule.
      delivery: { nextTurn: true, livePush: true, replyRoute: true },
    },
    // The first passing capture is the shipped minimum; the research lower
    // bound (2.1.80) is documented but not admitted without its own capture.
    //
    // The 2.1.260 release capture is passing evidence beside this, deliberately
    // not a second anchor: an anchor is the minimum's proof, one per platform,
    // and this contract has no maximum precisely so a newer stable client is
    // admitted by probe and a generation-bound handshake instead of by another
    // anchor. That capture is what exercised the rule - every branch observed
    // on 2.1.260 while the minimum stayed here. Two minor versions of drift,
    // served without a capture at either of them, is the rule working.
    nativeDelivery: {
      minimumByPlatform: { "darwin-arm64": CLAUDE_CHANNEL_MINIMUM },
      anchors: [{ platform: "darwin-arm64", version: CLAUDE_CHANNEL_MINIMUM,
        protocolContract: PROTOCOL_CONTRACT }],
      knownBad: [],
      activationKinds: ["shell-bootstrap", "native-config"],
    },

    startSession: async () => ({ ok: true, changes: [], diagnostics: [] }),
    endSession: async () => ({ ok: true, changes: [], diagnostics: [] }),
    guardWrite: async () => ({ ok: true, changes: [], diagnostics: [] }),
    guardShell: async () => ({ ok: true, changes: [], diagnostics: [] }),

    planInstall: context => planClaudeInstall(context),
    detect: context => detectClaude(context),
    install: context => installClaudePlugin({ ...context,
      livePolicy: context.livePolicy ?? "off" }),
    uninstall: context => uninstallClaudePlugin(context),

    doctor: async context => {
      const detected = await detectClaude(context);
      return { ok: true, changes: [], diagnostics: [
        ...detected.diagnostics,
        "hook payloads captured from Claude Code 2.1.233",
        CLAUDE_DELIVERY_FALLBACK.diagnostic,
        // SessionEnd is advisory and cannot summarise a conversation that has
        // already stopped, so the handoff is written from Stop or the skill.
        "handoff is written while the model is active, not at SessionEnd",
      ] };
    },

    probeNativeDelivery,
    planNativeActivation,
    bindNativeSession,
    offerMessage,
    routeReply,

    denyOutcome,
    injectOutcome,
    normalizeHook: payload => normalizeClaudeHook(payload),
    renderContext: (sync, options) => projectContext(sync, options),
    renderContextResult: (sync, options) => projectContextResult(sync, options),
  });
}
