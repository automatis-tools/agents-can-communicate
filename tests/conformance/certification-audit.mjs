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
// launch, a protocol contract, and the five delivery branches instead.
const nativeDelivery = (client, version, observedAt, fixture, protocolContract, idle, busy,
  limitations, capabilities = ["delivery.livePush", "delivery.replyRoute"]) => capabilities
  .map(capability => ({
  client, version, platform: "darwin-arm64", observedAt, capability, fixture, event: null,
  tool: null, protocolContract, outcome: "native-delivery-observed", idleBehavior: idle,
  busyBehavior: busy, authorityLevel: "experimental", limitations }));

const codexLocalDaemonLimitations = Object.freeze([
  "Observed on darwin-arm64 with an already-running LocalDaemon and ordinary commands; ACC adds no launch arguments and owns no vendor daemon lifecycle.",
  "Recorded recipient opt-in and exact current thread, canonical cwd, live process, stable version and protocol checks are required for every session.",
  "A 120-second delivery lease can refresh on demand for the same non-retired endpoint; this does not renew the 24-hour presence expiry.",
  "Unsupported or Embedded sessions and unreachable or rejected endpoints retain durable inbox delivery; accepted vendor queue entries cannot be withdrawn by policy off or uninstall.",
  "A loaded daemon thread may execute opted-in messages after its TUI exits. TUI detachment is not SessionEnd; explicit thread archive or actual server teardown retires it.",
  "Transport deduplication covers a pending queue entry only. Execution can repeat after queue consumption and acknowledgement loss.",
  "The observed reply loop uses the installed acc reply CLI; native delivery.replyRoute remains false. No new lifecycle, guard or next-turn certification follows.",
  "P16 is controlled endpoint fault injection. P18 uses an actual legacy npm artifact; its unrelated Claude shell artifact is not a real Claude capability capture.",
]);

const codexNativeDelivery = (version, observedAt, fixture) => nativeDelivery("codex-cli", version,
  observedAt, fixture,
  "codex-app-server-thread-queue-v1", "offered", "queued_after_turn",
  codexLocalDaemonLimitations, ["delivery.livePush"])
  .map(entry => ({ ...entry, launchMode: "ordinary-command-with-installed-hooks" }));

// A payload with no event name in it. Antigravity CLI sends no
// `hook_event_name`, and two of its four events carry byte-identical envelopes,
// so the fixture cannot name its own event and the provenance record is what
// says which hook ran. `eventInPayload: false` makes the conformance check
// assert the absence rather than skip the field.
const noEventField = entries => entries.map(entry => ({ ...entry, eventInPayload: false }));

export const PASS_EXPECTATIONS = Object.freeze({
  // Captured on the one version this client has been measured on. Three
  // capabilities, and the list of what is missing is longer than the list of
  // what is here: no tool event loads, so no guard; no SessionEnd, so no
  // lifecycle deregistration; no captured live push.
  "adapter-antigravity": withFacts("antigravity-cli", "1.2.7", noEventField([
    row("lifecycle.sessionStart", "fixtures/SessionStart-1.2.7.json", "SessionStart", null,
      "event-observed", "fires when a session starts",
      "fires before the first model invocation", "advisory",
      ["captured in print mode only",
        "no hook_event_name field; the event is known only from the command argument",
        "hooks attach only when the Antigravity session has an open workspace; an ordinary"
        + " print-mode turn sends an empty workspacePaths and no session is created. This"
        + " capture used --add-dir"]),
    row("context.beforeTurnInjection", "fixtures/PreInvocation-1.2.7.json", "PreInvocation",
      null, "model-visible", "waits for the next invocation",
      "does not interrupt an in-progress invocation", "context",
      ["requires the injectSteps ephemeralMessage envelope",
        "userMessage and toolCall injection types were not exercised",
        "hooks attach only when the Antigravity session has an open workspace; an ordinary"
        + " print-mode turn sends an empty workspacePaths and no session is created. This"
        + " capture used --add-dir"]),
    row("delivery.nextTurn", "fixtures/PreInvocation-1.2.7.json", "PreInvocation", null,
      "model-visible", "offers complete peer messages at the next invocation",
      "does not interrupt an in-progress invocation", "context", [
        "delivery requires the next invocation; there is no live push and no reply route",
        "the end-of-turn Stop continuation carries its reason to the model and is a bounded"
        + " nudge, not a gate: this adapter continues one turn at most once and the client"
        + " caps consecutive continuations itself (vendor 1.1.9)",
        "the continuation ceiling's own value was not captured, and neither was what the"
        + " model is told when it is reached",
        "captured on darwin-arm64 in print mode only; Linux, Windows and interactive"
        + " sessions were not observed",
        "agy agentapi send-message needs the running session's language-server address and"
        + " CSRF token, and hooks are given neither, so ACC has no live push",
        "reply routing back to ACC was not observed",
        "hooks attach only when the Antigravity session has an open workspace; an ordinary"
        + " print-mode turn sends an empty workspacePaths and no session is created. This"
        + " capture used --add-dir",
      ]),
  ]), "2026-09-20"),
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
    // Passing evidence beside 2.1.258, and deliberately not a second anchor:
    // an anchor is the minimum's proof, while this contract admits a newer
    // stable client by probe and handshake. The release capture is what
    // exercised that rule rather than replacing the tier it rests on.
    ...nativeDelivery("claude-code", "2.1.260", "2026-09-04T03:41:29.688Z",
      "fixtures/delivery/claude-code-2.1.260.json", "claude-code-channel-mcp-v1",
      "offered", "queued_after_turn", [
          "captured on darwin-arm64 only; Linux and Windows remain uncaptured",
          "the vendor development-channel warning stayed visible and was accepted by the operator by hand",
          "two ordinary sessions in one workspace, each bound to its own client process; the earlier 2.1.259 attempt is what exposed the channel binding another session identity, and this run is the verification of that fix",
          "duplicate was observed as one logical message id and one native offer: the repeated send took the durable path, so the channel was never asked to notify twice, and exactly one answer was recorded",
          "busy was observed by the operator: the running turn completed before the channel presented the message, and the session named that order in its own answer"
    ]),
  ]),
  "adapter-codex": [
    ...withFacts("codex-cli", "0.147.0", [
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
    ]),
    ...codexNativeDelivery("0.152.1", "2026-09-08T10:45:27.843Z",
      "fixtures/delivery/codex-cli-0.152.1-local-daemon-current-binding-product.json"),
    ...codexNativeDelivery("0.153.4", "2026-09-08T10:45:35.663Z",
      "fixtures/delivery/codex-cli-0.153.4-local-daemon-current-binding-product.json"),
  ],
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
