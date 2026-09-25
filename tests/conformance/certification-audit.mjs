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

const antigravityRelayLimitations = Object.freeze([
  "Observed on darwin-arm64 with Antigravity CLI 1.2.7 in the TUI, model Gemini 3.8 Flash, through a private candidate built from this branch and installed into an isolated ACC data home; print mode ends with its turn and runs no relay.",
  "The agent started the relay once for the conversation through run_command, after ACC's one-time context line named the command; the operator approved that command and each acc reply once at the client's permission prompt. ACC writes no permission rule.",
  "The relay holds the session's language-server address and CSRF token in memory only; ACC's registration carries a nonce and a socket path, never the endpoint. ANTIGRAVITY_AGENTAPI_EXE named the same agy the relay runs.",
  "An idle session woke with no user input. A message accepted while the model was streaming a long text answer was presented only after that answer completed. A message accepted while a turn waited on a tool permission was presented at that turn's next model invocation, after the tool returned, rather than after the turn.",
  "The busy branch took three sends: the first landed at a tool boundary as above, the second arrived after the answer had already finished and so showed an idle wake; the third, timed against the running stream, is the one recorded.",
  "The model receives each push as a SYSTEM_MESSAGE; the send-message title is not shown to it.",
  "The observed reply loop uses the installed acc reply CLI; native delivery.replyRoute remains false. The router reports a relay push as transport live-adapter.",
  "A repeated logical message kept its message id, took the durable path on the second send, and was pushed and answered once.",
  "Antigravity runs no SessionEnd: the relay retired itself about five seconds after its agy exited, and a later message stayed queued in the durable inbox.",
  "The first TUI session in a folder trusted at that launch hands every hook an empty workspacePaths even with --add-dir, so that session gets no ACC context and no relay prompt; the next launch in the now-trusted folder does.",
]);

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
  // lifecycle deregistration. Live push is captured through the relay the agent
  // starts, in the TUI only.
  "adapter-antigravity": [...withFacts("antigravity-cli", "1.2.7", noEventField([
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
  ...nativeDelivery("antigravity-cli", "1.2.7", "2026-09-21T19:29:23.548Z",
    "fixtures/delivery/antigravity-cli-1.2.7-relay-product.json", "antigravity-agentapi-relay-v1", "offered",
    "queued_after_turn", antigravityRelayLimitations, ["delivery.livePush"])
    .map(entry => ({ ...entry, launchMode: "ordinary-command-with-installed-hooks" }))],
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
    // The inbox wake's product capture: a private candidate of this branch,
    // real Claude Code 2.1.282 sessions, six cases. The Channel captures it
    // replaced are history now, kept as fixtures beside it.
    ...nativeDelivery("claude-code", "2.1.282", "2026-09-25T21:35:56.792Z",
      "fixtures/delivery/claude-code-2.1.282.json", "claude-code-inbox-socket-v1", "offered",
      "presented_between_tool_calls", [
      "Observed on darwin-arm64 with Claude Code 2.1.282 in the TUI, model Sonnet 5, auto permission mode, through a private candidate built from this branch and installed with an isolated ACC data home; the plugin registration in the real Claude config directory was restored byte for byte afterwards.",
      "Every wake carried ACC wording and the message id only. The body reached the model through the UserPromptSubmit projection that each delivered wake fired, inside the untrusted acc-peer-message block.",
      "An idle session started a turn with no user input. A wake sent while a Bash tool call ran was taken after that call returned and before the next one, and the turn continued.",
      "The observed reply loop uses the installed acc reply CLI; native delivery.replyRoute remains false. The router reports a wake as outcome woken via claude-inbox and leaves the receipt queued until the hook's output carried the body, which records it offered via next-turn.",
      "A repeated logical send kept its message id, took the durable path because the receipt was already acknowledged, and produced exactly one wake.",
      "Two sessions in one workspace each bound their own inbox; a message addressed to one never woke the other.",
      "An exited session left no registry entry; the next message stayed queued as recipient_unavailable.",
      "A receiving session in bypassPermissions mode was not captured; Claude Code documents that such a session holds each wake whose sender does not attest bypass, and ACC never attests a mode.",
      "Linux and native Windows remain uncaptured.",
    ], ["delivery.livePush"])
      .map(entry => ({ ...entry, launchMode: "ordinary-command-with-installed-hooks" })),
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
