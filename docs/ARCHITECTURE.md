# Architecture

This document describes the approved target (design approved 2026-08-15). Approved decisions and the remaining open technical items are recorded in `docs/DECISIONS.md`.

## Control plane, not execution plane

ACC owns coordination state. It does not own model inference, conversation history, permissions, sandboxes, or process lifecycle.

```text
┌──────────────────────────────────────────────────────────────┐
│ Execution planes                                             │
│ Codex │ Claude Code │ Gemini CLI │ MCP client │ native child │
└───────┬─────────────┬────────────┬────────────┬───────────────┘
        │ adapters    │            │            │
┌───────▼─────────────▼────────────▼────────────▼───────────────┐
│ ACC coordination plane                                       │
│ identity · sessions · intents · workstreams · tasks · claims │
│ messages · decisions · artifacts · handoffs · delivery state │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│ Durable local store + optional realtime notifier             │
└──────────────────────────────────────────────────────────────┘
```

## Components

### Core domain

Pure project-agnostic rules and validation:

- identifiers and schemas;
- session lifecycle;
- intents and workstreams;
- tasks and dependencies;
- generic resource claims;
- messages, decisions, artifacts, and handoffs;
- delivery state transitions;
- status and health rules.

Core cannot import Git, Codex, Claude, Gemini, MCP, or project-specific policy.

### Storage port

The domain consumes a storage interface with transactions, immutable event append, cursor reads, and materialized state access.

The first extraction should retain the hardened filesystem backend long enough to preserve behavior. A transactional backend can then be added behind the same interface. This prevents the storage rewrite from being mixed with product-semantic changes.

Runtime state belongs in a user data directory, not the project tree. Project configuration only contains optional shared policy and stable workspace identity.

### CLI

The CLI is the universal adapter boundary and human diagnostic surface. Commands return stable JSON envelopes in machine mode and concise text in human mode.

Expected high-level commands:

```text
acc attach
acc sync
acc work
acc claim
acc message
acc task
acc finish
acc status
acc doctor
acc install
```

Do not expose every internal transition as a separate model tool. High-level commands may perform atomic macro operations.

### Adapter SDK

Adapters translate a harness lifecycle into core operations. They contain vendor-specific file formats, hook inputs, safe-point delivery, and tool-guard extraction.

An adapter declares capabilities rather than inheriting optimistic defaults.

### Native adapter packages

- Codex plugin: skill, MCP server registration, and supported lifecycle hooks.
- Claude Code plugin: hooks, skill, MCP tools/resources, and subagent lifecycle mapping.
- Gemini CLI extension: hooks, skills, MCP server, policy rules where appropriate, and subagent mapping.
- Generic MCP server: explicit tools/resources with polling semantics and no implied lifecycle guarantees.

### Optional notifier

A lightweight local process may watch durable events and notify connected adapters. It is never authoritative. CLI and hooks remain correct if it is absent or crashes.

## Workspace discovery

Discovery returns a `WorkspaceDescriptor`:

```ts
export interface WorkspaceDescriptor {
  id: string;
  roots: string[];
  source: "config" | "git" | "directory";
  displayName: string;
  git?: {
    commonDir: string;
    worktreeRoot: string;
    branch: string | null;
    head: string | null;
    remote: string | null;
  };
}
```

Resolution order:

1. explicit CLI/env override;
2. nearest optional project config;
3. Git common directory identity, if present;
4. canonical workspace root path.

Multiple Git worktrees of one repository share workspace awareness while retaining distinct checkout metadata. Non-Git directories remain fully supported.

## Lazy workspace materialization

Attachment is universal, but durable state is not created merely because a session opened somewhere (approved 2026-08-15). A lone session writes only ephemeral presence and Intent records in the runtime area. The Workspace materializes durable state — protocol identity, event log, materialized views — exactly once, at the first moment coordination actually exists: a second live session attaches, or the session creates its first durable object (claim, message, task, workstream, decision, artifact, or handoff). At that moment current ephemeral presence and Intents are recorded durably and the event log begins. Ephemeral-only workspaces vanish without a trace once their sessions close; `acc doctor` may garbage-collect any that were abandoned.

A lone session also pays no attention cost: adapters inject no coordination context while the roster has no peers and no attention items, and tool guards short-circuit against the empty claim set.

## Event model

Every meaningful mutation appends an immutable event and updates materialized state atomically.

```ts
export interface AccEvent<T = unknown> {
  sequence: bigint;
  eventId: string;
  workspaceId: string;
  actorSessionId: string;
  type: string;
  occurredAt: string;
  payload: T;
}
```

Adapters sync with a cursor:

```ts
export interface SyncResult {
  cursor: string;
  snapshot?: WorkspaceSnapshot;
  events: AccEvent[];
  attention: AttentionItem[];
}
```

The core compacts routine heartbeat noise. The model receives a concise snapshot or delta, not an event dump.

## Consistency boundaries

- Workspace identity is checked before any mutation.
- Claims are acquired and conflict-checked atomically.
- Event publication and materialized state update are one transaction.
- Acknowledgements never overwrite messages or earlier receipts.
- Force operations record actor, reason, and prior generation.
- Recovery and doctor operations fail closed on ambiguous ownership.
- Unsupported adapter capabilities never silently fall back to stronger claims.

## Coordinator semantics

A workstream may have zero or one active coordinator lease. The coordinator plans and synthesizes; it is not the transport or durable owner.

If the coordinator disappears:

- existing claims and tasks remain valid until their own expiry or completion;
- peers may continue within already agreed scopes;
- decisions requiring coordination become attention items;
- another participant or the human may acquire the coordinator role according to policy.

The coordinator is a planning convenience, never an information gatekeeper: any session can answer for the whole Workspace and relay human requests to any participant. Authority differences apply to mutation only, never to knowledge.

## Native subagents

Adapters may report parent/child session relationships. Short-lived children remain collapsed unless they obtain a task, claim a resource, send an external message, or exceed the adapter's visibility threshold. Collapse reduces noise; it is not secrecy — any session may query collapsed children on demand through a full-scope sync.

## Realtime and wake behavior

No universal wake guarantee exists. Capabilities distinguish:

- durable queue only;
- poll on prompt or tool boundary;
- inject at next safe point;
- realtime notification to an active harness;
- managed process wake, reserved for a possible future runner.

Delivery status must reflect the strongest observed fact, not intent.

## Presence freshness

Presence has three observable states: online, stale, and offline. Heartbeats arrive only at moments the harness actually exposes — hook safe points for native adapters, tool calls for MCP clients — so an idle but open session naturally degrades to stale. That is truthful reporting, not an error. Each adapter declares its expected heartbeat cadence, and the staleness window derives from that declaration rather than one global constant. The first release ships no heartbeat helper: an idle session is truthfully reported stale, and that display is expected, not an error (approved 2026-08-15). A detached helper (the prototype's watcher pattern) remains a possible later opt-in. Liveness probes and claim lease expiry, never presence staleness alone, decide when ownership may be replaced.
