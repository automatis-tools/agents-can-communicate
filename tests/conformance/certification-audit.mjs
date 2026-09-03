// Independent literals transcribed from each adapter's real-client
// COMPATIBILITY.md and fixtures/README.md observations as they existed before
// Task 6. This module deliberately imports neither manifests nor provenance.
const row = (capability, fixture, event, tool, outcome, idleBehavior, busyBehavior,
  authorityLevel, limitations) => ({ capability, fixture, event, tool, outcome,
  idleBehavior, busyBehavior, authorityLevel, limitations });

const nextTurn = (fixture, event, limitation) => row("delivery.nextTurn", fixture,
  event, null, "model-context-observed", "offers complete peer messages at the next prompt",
  "does not interrupt an in-progress turn", "context", [limitation]);

const withFacts = (client, version, entries, observedAt = "2026-08-16") => entries
  .map(entry => ({ client, version, platform: "darwin-arm64", observedAt, ...entry }));

// A native delivery capture has no hook event or tool: it proves an ordinary
// launch, a protocol contract, and the five delivery branches instead. Both
// livePush and replyRoute rest on the same redacted capture.
const nativeDelivery = (client, version, observedAt, fixture, protocolContract, idle, busy,
  limitations, capabilities = ["delivery.livePush", "delivery.replyRoute"]) => capabilities
  .map(capability => ({
  client, version, platform: "darwin-arm64", observedAt, capability, fixture, event: null,
  tool: null, protocolContract, outcome: "native-delivery-observed", idleBehavior: idle,
  busyBehavior: busy, authorityLevel: "experimental", limitations }));

export const PASS_EXPECTATIONS = Object.freeze({
  "adapter-claude-code": withFacts("claude-code", "2.1.233", [
    row("lifecycle.sessionStart", "fixtures/SessionStart.json", "SessionStart", null,
      "event-observed", "fires when a session starts", "fires before the first model turn",
      "advisory", ["capture used a one-session --plugin-dir"]),
    row("lifecycle.sessionEnd", "fixtures/SessionEnd.json", "SessionEnd", null,
      "event-observed", "fires when a session exits", "does not run until the session exits",
      "advisory", ["cannot write a handoff after the model has stopped"]),
    row("context.beforeTurnInjection", "fixtures/UserPromptSubmit.json", "UserPromptSubmit",
      null, "model-context-observed", "waits for the next user prompt",
      "does not interrupt an in-progress turn", "context",
      ["requires the hookSpecificOutput additionalContext envelope"]),
    row("guards.beforeWrite", "fixtures/PreToolUse-Edit.json", "PreToolUse", "Edit",
      "tool-denied-before-mutation", "no write exists to guard",
      "denies a file edit before disk mutation", "blocking",
      ["runtime writes are outside the hook boundary"]),
    row("guards.beforeShell", "fixtures/PreToolUse.json", "PreToolUse", "Bash",
      "tool-denied-before-execution", "no shell call exists to guard",
      "denies a Bash call before execution", "blocking",
      ["only tool calls reaching PreToolUse are guarded"]),
    nextTurn("fixtures/UserPromptSubmit.json", "UserPromptSubmit",
      "delivery requires the next normal user turn"),
    ...nativeDelivery("claude-code", "2.1.258", "2026-09-02T21:20:11.676Z",
      "fixtures/delivery/claude-code-2.1.258.json", "claude-code-channel-mcp-v1",
      "offered", "queued_after_turn", [
          "captured on darwin-arm64 only; Linux and Windows remain uncaptured",
          "the vendor development-channel warning stayed visible and was accepted by the operator by hand",
          "the plugin .mcp.json must live in the marketplace source copy; the plugin cache copy alone is not read",
          "acc_reply routed through the spike's explicit tool call; the spike created no durable ACC answer record",
          "presentation after the busy turn was observed by the operator; the channel log records the write at 21:18:45Z and the explicit reply at 21:19:21Z"
    ]),
  ]),
  "adapter-codex": withFacts("codex-cli", "0.147.0", [
    row("lifecycle.sessionStart", "fixtures/SessionStart.json", "SessionStart", null,
      "event-observed", "fires when a client session starts",
      "fires before the first model turn", "advisory",
      ["plugin hooks must be explicitly trusted by the user"]),
    row("lifecycle.sessionEnd", "fixtures/SessionEnd.json", "SessionEnd", null,
      "event-observed", "fires when a client session exits",
      "does not run until the session exits", "advisory",
      ["plugin hooks must be explicitly trusted by the user"]),
    row("context.beforeTurnInjection", "fixtures/UserPromptSubmit.json", "UserPromptSubmit",
      null, "model-context-observed", "waits for the next user prompt",
      "does not interrupt an in-progress turn", "context",
      ["stdout arrives as an unwrapped developer-role message"]),
    row("guards.beforeWrite", "fixtures/PreToolUse.json", "PreToolUse", "apply_patch",
      "tool-denied-before-mutation", "no write exists to guard",
      "blocks an apply_patch call before disk mutation", "blocking",
      ["runtime and unrecognised shell writes can bypass the guard"]),
    nextTurn("fixtures/UserPromptSubmit.json", "UserPromptSubmit",
      "delivery requires the next normal user turn"),
    // Codex has no native-delivery pass. The 0.152.1 queue capture observed a
    // working transport; the release capture then measured that the mode it
    // requires - codex --remote unix:// - reports the daemon's directory as the
    // session's, from both the hook payload and the App Server's thread record.
    // A session ACC cannot place must not be addressed, so the verdict for that
    // tuple is the failure capture and the capability is withdrawn.
  ]),
  // Re-captured on the version this machine actually runs. 0.57.0 added folder
  // trust, which silently downgrades the approval mode and with it the toolset,
  // so the guard paths are reachable only from an explicitly trusted folder.
  "adapter-gemini-cli": withFacts("gemini-cli", "0.57.0", [
    row("lifecycle.sessionStart", "fixtures/SessionStart-0.57.0.json", "SessionStart", null,
      "event-observed", "fires when a session starts", "fires before the first model turn",
      "advisory", ["capture used an isolated HOME and a locally stubbed model endpoint"]),
    row("lifecycle.sessionEnd", "fixtures/SessionEnd-0.57.0.json", "SessionEnd", null,
      "event-observed", "fires when a session exits", "does not run until the session exits",
      "advisory", ["handoff must be written before session end"]),
    row("context.beforeTurnInjection", "fixtures/BeforeAgent-0.57.0.json", "BeforeAgent", null,
      "model-context-observed", "waits for the next user prompt",
      "does not interrupt an in-progress turn", "context",
      ["requires the hookSpecificOutput additionalContext envelope; the client forwards it"
        + " to the model as a <hook_context> part"]),
    row("guards.beforeWrite", "fixtures/BeforeTool-0.57.0.json", "BeforeTool", "write_file",
      "tool-denied-before-mutation", "no write exists to guard",
      "blocks write_file before mutation", "blocking",
      ["write tools are absent in the default and plan approval modes; the capture used yolo",
        "an untrusted folder silently downgrades the approval mode, so the capture disabled"
        + " security.folderTrust"]),
    row("guards.beforeShell", "fixtures/BeforeTool-shell-0.57.0.json", "BeforeTool",
      "run_shell_command", "tool-denied-before-execution", "no shell call exists to guard",
      "blocks run_shell_command before execution", "blocking",
      ["run_shell_command is absent below the yolo approval mode",
        "a deny must be {\"decision\":\"block\"}; the hookSpecificOutput permissionDecision"
        + " shape still does not deny on this client"]),
    nextTurn("fixtures/BeforeAgent-0.57.0.json", "BeforeAgent",
      "delivery requires the next normal user turn"),
  ], "2026-09-03"),
  "adapter-grok": [],
  "adapter-kimi": withFacts("kimi", "0.36.1", [
    row("lifecycle.sessionStart", "fixtures/SessionStart.json", "SessionStart", null,
      "event-observed", "fires when a session starts", "fires before the first model turn",
      "advisory", ["prompt-mode session end is not emitted"]),
    row("lifecycle.heartbeat", "fixtures/SessionHeartbeat.json", "SessionHeartbeat", null,
      "fixed-cadence-observed", "fires every 60 seconds while idle",
      "continues on the same fixed cadence", "advisory",
      ["a process that exits before one minute emits no heartbeat"]),
    row("context.beforeTurnInjection", "fixtures/UserPromptSubmit.json", "UserPromptSubmit",
      null, "model-context-observed", "waits for the next user prompt",
      "does not interrupt an in-progress turn", "context",
      ["the client wraps raw stdout as hook_result"]),
    row("guards.beforeWrite", "fixtures/PreToolUse-Write.json", "PreToolUse", "Write",
      "tool-denied-before-mutation", "no write exists to guard",
      "denies Write before mutation", "blocking",
      ["runtime writes are outside the hook boundary"]),
    row("guards.beforeShell", "fixtures/PreToolUse-Bash.json", "PreToolUse", "Bash",
      "tool-denied-before-execution", "no shell call exists to guard",
      "denies Bash before execution", "blocking",
      ["only tool calls reaching PreToolUse are guarded"]),
    nextTurn("fixtures/UserPromptSubmit.json", "UserPromptSubmit",
      "delivery requires the next normal user turn"),
  ]),
});
