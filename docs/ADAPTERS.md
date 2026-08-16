# Adapter model

## Purpose

Adapters translate client-specific lifecycle and tool events into the project-agnostic ACC protocol. The core never checks `if vendor === "claude"` or equivalent.

## Capability declaration

```ts
export interface AdapterCapabilities {
  lifecycle: {
    sessionStart: boolean;
    sessionResume: boolean;
    sessionEnd: boolean;
    heartbeat: boolean;
    childSessions: boolean;
  };
  context: {
    startupInjection: boolean;
    beforeTurnInjection: boolean;
    safePointInjection: boolean;
  };
  guards: {
    beforeRead: boolean;
    beforeWrite: boolean;
    beforeShell: boolean;
  };
  delivery: {
    polling: boolean;
    activeNotification: boolean;
    wakeDormantSession: boolean;
  };
  execution: {
    launch: boolean;
    resume: boolean;
    terminate: boolean;
  };
}
```

False is the default for every capability. An adapter test must prove each true value.

`lifecycle.heartbeat` is separate from `delivery.polling` on purpose. Polling
happens when the client reaches a hook, which for most harnesses means when the
user takes a turn: an idle session stops refreshing and goes stale even though
its process is alive. A client with `lifecycle.heartbeat` fires on a timer
instead, so presence stays accurate while the session sits idle. Only Kimi Code
was observed doing this, at a fixed 60s cadence.

## Integration tiers

### Tier 0 — CLI only

- human or model invokes `acc` explicitly;
- no automatic lifecycle;
- durable messages, status, and claims remain available.

### Tier 1 — Generic MCP

- model can call high-level coordination tools;
- read-only resources expose snapshot and inbox;
- polling is required;
- no implied write guard or session-end cleanup.

### Tier 2 — Skills plus lifecycle hooks

- automatic attach and heartbeat;
- compact context at startup or before turns;
- model receives semantic workflow instructions;
- cleanup at supported session end;
- write conflicts may be guarded.

### Tier 3 — Native realtime

- active-session delivery receipts;
- safe-point context injection;
- child-session visibility;
- exact lifecycle status.

ACC v1 should target Tier 2 for Codex, Claude Code, and Gemini CLI. Tier 3 is enabled only where the public harness contract genuinely supports it.

## Adapter interface

```ts
export interface HarnessAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: AdapterCapabilities;

  detect(context: DetectContext): Promise<DetectionResult>;
  install(context: InstallContext): Promise<InstallResult>;
  uninstall(context: InstallContext): Promise<InstallResult>;
  doctor(context: DoctorContext): Promise<AdapterDoctorResult>;
  normalizeHook(input: unknown): Promise<NormalizedHookEvent>;
  renderContext(sync: SyncResult): Promise<InjectedContext>;
}
```

Installation must be idempotent and preserve unrelated user configuration. Uninstall removes only records owned by ACC.

## Codex adapter

Package target: `packages/adapter-codex/`.

Bundle:

- ACC skill with semantic coordination behavior;
- hooks for the lifecycle points officially supported by the installed Codex version;
- MCP server registration or plugin declaration;
- adapter doctor that reports missing or disabled hook support;
- no assumption that every OpenAI model is running inside Codex.

The adapter must distinguish Codex top-level sessions from nested subagents where hook metadata permits it.

## Claude Code adapter

Package target: `packages/adapter-claude-code/`.

Use documented `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`, `SubagentStart`, and `SubagentStop` surfaces only where needed.

Important constraints:

- `PreToolUse` can block, but `SessionStart` and `SessionEnd` are advisory;
- Stop is not a guaranteed substitute for cleanup after every interruption;
- agent-team teammates and ordinary subagents should map to explicit parent/child session metadata;
- ACC does not replace Claude Agent Teams; it makes their visible participants interoperable with external sessions.

Primary docs: <https://code.claude.com/docs/en/hooks>

## Gemini CLI adapter

Package target: `packages/adapter-gemini-cli/`.

Distribute as a Gemini extension containing:

- hooks;
- ACC skill;
- MCP configuration;
- optional policy rules limited to ACC claim enforcement;
- subagent mapping.

Use `SessionStart`, `BeforeAgent`, `BeforeTool`, `AfterTool`, `AfterAgent`, and `SessionEnd` according to documented behavior. Keep stdout strictly JSON in hook executables.

Primary docs:

- <https://geminicli.com/docs/extensions/>
- <https://geminicli.com/docs/hooks/>

## Generic MCP adapter

Package target: `packages/mcp-server/`.

Keep the model-facing surface compact:

```text
acc_sync
acc_work
acc_claim
acc_message
acc_task
acc_finish
```

Read-only resources may expose workspace snapshot, participant roster, workstream, task, and inbox views. The server description must state that the client needs to poll and that MCP does not guarantee lifecycle or wake behavior.

## Future adapters

Kimi, Cursor, Copilot, OpenCode, and custom harnesses should implement the same manifest and conformance suite. A compatible model served through an already supported harness does not require a model-specific adapter.

## Conformance suite

Every adapter is tested against a shared matrix:

- detection and idempotent installation;
- preservation of existing config;
- capability truthfulness;
- attach/resume/close lifecycle where declared;
- correct workspace identity;
- compact context rendering;
- claim conflict guard where declared;
- queued delivery when injection is unavailable;
- exact cleanup ownership;
- no raw transcript collection;
- uninstall preserves unrelated configuration.
