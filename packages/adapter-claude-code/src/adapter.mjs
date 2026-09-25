import { defineAdapter, projectContext, projectContextResult }
  from "@agents-can-communicate/adapter-sdk";
import certification from "../certification.json" with { type: "json" };

import { denyOutcome, injectOutcome, injectStartOwnerOutcome, normalizeClaudeHook } from "./hooks.mjs";
import { MIN_VERSION, PROTOCOL_CONTRACT, bindNativeSession, offerMessage, planNativeActivation,
  probeNativeDelivery, refreshNativeSession, retireNativeSession } from "./inbox-delivery.mjs";
import { planClaudeInstall, detectClaude, installClaudePlugin, uninstallClaudePlugin } from "./install.mjs";

export const CLAUDE_CODE_VERSION = "2.1.233";
export const CLAUDE_DELIVERY_FALLBACK = Object.freeze({
  diagnostic: `Claude Code live delivery wakes a session through its inbox socket from ${MIN_VERSION}; `
    + "fallback: next-turn hooks or acc inbox",
});
// Claude Code's own inbound controls decide whether a wake reaches the model.
// ACC never attests a permission mode, so a session that bypasses permission
// prompts holds each wake for approval; the message still arrives with its
// next turn either way.
export const CLAUDE_INBOUND_NOTE = "a Claude Code session that bypasses permission prompts holds "
  + "each ACC wake for approval unless crossSessionInbound is accept; its next turn still shows "
  + "the message";

/**
 * Every true capability below was observed in a real `claude -p` session on
 * 2.1.233; fixtures are in fixtures/ and the evidence is in COMPATIBILITY.md.
 *
 * What stays false and why. `childSessions` is unproven: SubagentStart and
 * SubagentStop are documented and real, but no subagent ran during the capture,
 * and a parent/child mapping claimed without observation is the kind of thing
 * that quietly maps every child onto its parent. `startupInjection` and
 * `safePointInjection` were not exercised - only the before-turn path was.
 * Native live delivery is the inbox wake, certified from 2.1.282 on
 * darwin-arm64; reply routing through the transport is not claimed.
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
      // nextTurn is the certified 2.1.233 hook projection. livePush rests on
      // the 2.1.282 product capture of the inbox wake; the reply is the
      // ordinary `acc reply` every adapter has, so replyRoute stays false.
      delivery: { nextTurn: true, livePush: true },
    },

    // The first passing capture is the minimum, and there is no maximum: a
    // newer stable client is admitted by the probe and the per-session
    // handshake. The offer is a wake; see src/inbox-delivery.mjs.
    nativeDelivery: {
      minimumByPlatform: { "darwin-arm64": MIN_VERSION },
      anchors: [{ platform: "darwin-arm64", version: MIN_VERSION, protocolContract: PROTOCOL_CONTRACT }],
      knownBad: [],
      activationKinds: ["native-service"],
      policySource: "installation-record",
      offerKind: "wake",
    },

    startSession: async () => ({ ok: true, changes: [], diagnostics: [] }),
    endSession: async () => ({ ok: true, changes: [], diagnostics: [] }),
    guardWrite: async () => ({ ok: true, changes: [], diagnostics: [] }),
    guardShell: async () => ({ ok: true, changes: [], diagnostics: [] }),

    planInstall: context => planClaudeInstall(context),
    detect: context => detectClaude(context),
    install: context => installClaudePlugin(context),
    uninstall: context => uninstallClaudePlugin(context),

    doctor: async context => {
      const detected = await detectClaude(context);
      return { ok: true, changes: [], diagnostics: [
        ...detected.diagnostics,
        "hook payloads captured from Claude Code 2.1.233",
        CLAUDE_DELIVERY_FALLBACK.diagnostic,
        CLAUDE_INBOUND_NOTE,
        // SessionEnd is advisory and cannot summarise a conversation that has
        // already stopped, so the handoff is written from Stop or the skill.
        "handoff is written while the model is active, not at SessionEnd",
      ] };
    },

    probeNativeDelivery,
    planNativeActivation,
    bindNativeSession,
    refreshNativeSession,
    retireNativeSession,
    offerMessage,

    denyOutcome,
    injectOutcome,
    injectStartOwnerOutcome,
    normalizeHook: payload => normalizeClaudeHook(payload),
    renderContext: (sync, options) => projectContext(sync, options),
    renderContextResult: (sync, options) => projectContextResult(sync, options),
  });
}
