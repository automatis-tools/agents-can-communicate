# Product vision

## Problem

Developers increasingly keep several independent AI work sessions open at once: Codex for implementation, Claude Code for design or review, Gemini CLI for research, and additional agents for specialist work. Each session has its own memory, tools, permissions, and conversation. They can all touch the same project while remaining unaware of one another.

The human becomes the transport layer: copying messages, explaining decisions again, checking whether files overlap, and discovering conflicts only after work is complete.

Native subagent systems solve this inside one harness. They do not create a shared coordination plane across vendors and independently opened chats.

## Product statement

Agents Can Communicate is an ambient, model- and harness-agnostic coordination fabric for independent AI-agent sessions.

It lets sessions:

- discover who else is active;
- declare what they are doing without requiring a formal task;
- coordinate through workstreams when useful;
- claim files or other resources before conflicting work;
- exchange questions, decisions, artifacts, and handoffs;
- receive only the relevant changes since their last sync;
- continue safely even when no coordinator session is active.

## What ACC is not

- It is not an LLM or agent runtime.
- It is not a replacement for Codex, Claude Code, Gemini CLI, or native subagents.
- It is not a task manager that requires every activity to become a ticket.
- It is not a permanent central orchestrator.
- It does not own, spawn, or terminate user sessions by default.
- It is not transcript synchronization.
- It is not Git-only and not coding-only, even though coding is the first integration target.

## Core differentiation

Existing systems usually begin from one of two assumptions:

1. agents explicitly call a mailbox protocol; or
2. one orchestrator launches and owns worker processes.

ACC begins from a different assumption: the user already has independent sessions open in their preferred products. ACC attaches them to a common awareness and safety plane without changing who owns those sessions.

The resulting topology is federated:

```text
Human-driven Codex session ─┐
Human-driven Claude session ├─ shared workspace state
Human-driven Gemini session ┤  intents, claims, messages,
Native subagents ───────────┘  tasks, decisions, artifacts
```

## Product principles

### Silent unless actionable

Routine attachment, heartbeat, and non-conflicting awareness should not interrupt the user. Surface only conflicts, direct requests, decisions, blockers, and capability failures.

### Awareness before orchestration

Every supported session can participate in ambient workspace awareness. Workstreams, tasks, and coordinators appear only when the work needs them.

### Any session speaks for the whole workspace

The human may ask any open session about the entire system — who is active, what other models and their subagents are doing, what was decided — and route a request to any participant through it. This is collective work among equals, not one boss with dumb workers: knowledge is symmetric, and only mutation authority is scoped.

### Durable before realtime

A state transition is recorded before delivery is attempted. Realtime notification accelerates delivery but never becomes the source of truth.

### Truthful capability degradation

An MCP-only client is still useful, but it cannot pretend to have lifecycle hooks or write guards. The product exposes the difference.

### Human authority remains explicit

Agent messages are peer input. They cannot silently elevate permissions, override the user, or force-release another participant's work.

### Compact context, not transcript flooding

Agents consume snapshots and cursor-based deltas. Raw histories remain opt-in artifacts.

## First-release success

A successful first release demonstrates this scenario on one machine:

1. A Codex session opens in a project and silently attaches.
2. A Claude Code session opens independently and sees Codex's current intent.
3. A Gemini CLI session opens and joins the same awareness plane.
4. Non-overlapping work proceeds without user prompts.
5. An overlapping write is blocked or clearly warned before mutation where the adapter supports guards.
6. One session sends a contract request; the recipient receives it at the next supported safe point.
7. The sender can distinguish queued, injected, seen, and acknowledged states.
8. Closing a session releases lifecycle ownership without erasing durable handoffs.
9. The same core works in a non-Git directory with reduced metadata but unchanged collaboration semantics.
