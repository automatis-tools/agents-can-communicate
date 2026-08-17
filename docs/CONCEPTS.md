# Concepts

## The problem

You keep several agent sessions open at once — often on different branches, in different
git worktrees. Each has its own model, memory, permissions, and human. None of them knows
what the others are doing, and none can ask another for anything.

So you become the transport. You carry questions between them, repeat decisions, and hand
over pieces of work by pasting context from one window into another.

```mermaid
graph LR
  subgraph "Without ACC"
    A1[Codex] --> H1((you))
    B1[Claude Code] --> H1
    H1 --> C1[Kimi]
  end
  subgraph "With ACC"
    A2[Codex] --- ACC{{ACC}}
    B2[Claude Code] --- ACC
    ACC --- C2[Kimi]
  end
```

Native subagents solve this *inside* one product, for sessions that product created. ACC
solves it *between* products, for sessions you opened yourself.

## Asking, not commanding

The central move is one agent asking another for a piece of work. It writes the request and
the reason as one thing, and the other agent is told at its next turn.

Nobody is in charge. A request is a request: the recipient can take it, leave it, or answer
the message instead. Authority differences apply to mutation only — never to knowledge, and
never to who may ask whom.

Work is addressed to a **participant** rather than a session, so it survives that agent
restarting. Only the named participant can take it. Work addressed to nobody is open to
anyone.

## What ACC is not

- not a model or an agent runtime;
- not a replacement for Codex, Claude Code, Gemini CLI, or Kimi;
- not a task tracker that turns every action into a ticket;
- not a permanent central orchestrator;
- not transcript synchronisation;
- not Git-only, and not coding-only.

## Five ideas

| Idea | What it means |
|---|---|
| **Ambient** | Attachment, presence, and guards happen inside your normal session. No new commands. |
| **Peer equality** | No session is in charge. Any session can answer for the whole workspace. |
| **Durable first** | State is recorded before delivery is attempted. Realtime would only accelerate it. |
| **Truthful capability** | An adapter declares only what was observed. Degradation is visible, never silent. |
| **Silent when alone** | One session pays nothing: no injected context, no protocol, no banners. |

## Objects

```mermaid
graph TB
  W[Workspace] --> P[Participant]
  P --> S[Session]
  S --> I[Intent<br/>what I am doing now]
  S --> C[Claim<br/>a resource I reserved]
  S --> M[Message<br/>typed, attributed, untrusted]
  W --> WS[Workstream<br/>optional grouping]
  WS --> T[Task<br/>optional, with dependencies]
```

**Intent** is awareness — it never authorises anything. **Claim** is the thing that can stop
a write. The two are deliberately separate: announcing that you are editing is cheap and
constant; reserving a resource is a commitment other sessions are held to.

## When coordination starts

```mermaid
sequenceDiagram
  participant S1 as First session
  participant ACC
  participant S2 as Second session
  S1->>ACC: attach
  Note over ACC: ephemeral only — nothing durable, nothing injected
  S2->>ACC: attach
  Note over ACC: workspace materialises — both sessions see each other
```

Durable state appears at the first moment coordination actually exists: a second live
session, or the first claim, message, task, or handoff. A workspace that never got a second
session leaves nothing behind.

## Joining someone else's work

| Situation | What a session does |
|---|---|
| Explicit invitation, or the same workstream id | join |
| Exact conflicting resource | stop before writing, ask or negotiate |
| Merely similar topic | mention it, do not merge work |
| Unrelated | continue, silently |
| Human said "work independently" | stay independent — claims still apply |

## Coordinators

A workstream may have one coordinator. It plans and synthesises; it is not the transport
and not the owner of durable state. If it disappears, claims and tasks stay valid, and
another participant can take the lease.

Authority differences apply to **mutation only, never to knowledge**. Any session can be
asked what the whole system is doing.

## Protection is a property of the room

A claim is `guarded` only while every live session can actually be stopped. One MCP client,
one shell-editing model, and the workspace reports `advisory` — because that is the truth.

See [CAPABILITIES.md](CAPABILITIES.md) for what each client was measured doing.
