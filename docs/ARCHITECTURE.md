# Proposed architecture

This document describes the recommended target. Items not yet approved are marked in `docs/DECISIONS.md`.

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

## Native subagents

Adapters may report parent/child session relationships. Short-lived children remain collapsed unless they obtain a task, claim a resource, send an external message, or exceed the adapter's visibility threshold.

## Realtime and wake behavior

No universal wake guarantee exists. Capabilities distinguish:

- durable queue only;
- poll on prompt or tool boundary;
- inject at next safe point;
- realtime notification to an active harness;
- managed process wake, reserved for a possible future runner.

Delivery status must reflect the strongest observed fact, not intent.
