import { defineAdapter, projectContext } from "@agents-can-communicate/adapter-sdk";

import { denyOutcome, injectOutcome, normalizeClaudeHook } from "./hooks.mjs";
import { planClaudeInstall, detectClaude, installClaudePlugin, uninstallClaudePlugin } from "./install.mjs";

export const CLAUDE_CODE_VERSION = "2.1.233";

/**
 * Every true capability below was observed in a real `claude -p` session on
 * 2.1.233; fixtures are in fixtures/ and the evidence is in COMPATIBILITY.md.
 *
 * What stays false and why. `childSessions` is unproven: SubagentStart and
 * SubagentStop are documented and real, but no subagent ran during the capture,
 * and a parent/child mapping claimed without observation is the kind of thing
 * that quietly maps every child onto its parent. `startupInjection` and
 * `safePointInjection` were not exercised - only the before-turn path was.
 * `execution.*` and wake are not offered by this harness.
 */
export function createClaudeCodeAdapter() {
  return defineAdapter({
    id: "claude_code",
    displayName: "Claude Code",
    capabilities: {
      lifecycle: { sessionStart: true, sessionEnd: true },
      // A UserPromptSubmit hook's additionalContext was observed arriving in
      // the session, and the model treated it as data rather than instruction.
      context: { beforeTurnInjection: true },
      // PreToolUse denied both a Write and a Bash call; neither ran.
      guards: { beforeWrite: true, beforeShell: true },
      delivery: { polling: true },
    },

    startSession: async () => ({ ok: true, changes: [], diagnostics: [] }),
    endSession: async () => ({ ok: true, changes: [], diagnostics: [] }),
    guardWrite: async () => ({ ok: true, changes: [], diagnostics: [] }),
    guardShell: async () => ({ ok: true, changes: [], diagnostics: [] }),
    poll: async () => ({ ok: true, changes: [], diagnostics: [] }),

    planInstall: context => planClaudeInstall(context),
    detect: context => detectClaude(context),
    install: context => installClaudePlugin(context),
    uninstall: context => uninstallClaudePlugin(context),

    doctor: async context => {
      const detected = await detectClaude(context);
      return { ok: true, changes: [], diagnostics: [
        ...detected.diagnostics,
        "hook payloads captured from Claude Code 2.1.233",
        // SessionEnd is advisory and cannot summarise a conversation that has
        // already stopped, so the handoff is written from Stop or the skill.
        "handoff is written while the model is active, not at SessionEnd",
      ] };
    },

    denyOutcome,
    injectOutcome,
    normalizeHook: payload => normalizeClaudeHook(payload),
    renderContext: (sync, options) => projectContext(sync, options),
  });
}
