---
id: "acc-vs-concord-mcp"
title: "ACC vs Concord MCP: Messages and Explicit Work State"
description: "Compare ACC and Concord MCP for local coding-agent communication, ownership, handoffs, and the amount of work state shared between clients."
route: "/compare/acc-vs-concord-mcp/"
type: "comparison"
order: 50
status: "reviewed"
language: "en"
author: "ACC project"
lastVerified: "2026-10-21"
accVersion: "0.11.1"
evidenceLevel: "documentation-comparison"
sources: ["acc-fit", "acc-concepts", "acc-architecture", "concord-readme"]
---

# ACC vs Concord MCP: Messages and Explicit Work State

Consider ACC for peer conversation and coordination facts around sessions you manage yourself. Consider Concord MCP when the shared layer should also represent explicit task ownership, acceptance, and review state.

## Decide what the shared layer should know

ACC has presence, intent, claims, conversations, receipts, and handoffs. It deliberately has no task or workstream subsystem. Your existing issue tracker and your instructions remain responsible for deciding the work.

Concord combines messaging with task context, assignment, acceptance, versioned ownership changes, and review state. A configured repository uses `.concord/`; global mode keeps work for repositories without local setup in `~/.concord/global.db`. See the [Concord documentation](https://github.com/Get-Concord-AI/concord-mcp).

| Question | ACC model | Concord concept to examine |
|---|---|---|
| What is shared? | Session and communication facts. | Task context and communication. |
| Does acknowledging a handoff accept the task? | No; scope acceptance is a separate conversation. | Explicit handoff and ownership transitions. |
| Where does execution authority stay? | Each session retains its own instructions and permissions. | Examine transition rules and receiving-client behavior. |
| What owns the project backlog? | Your chosen tracker or existing process. | Decide which task state you want in the coordination layer. |

A richer state model is useful when you need those transitions. A narrower model is useful when you want messages around an existing process.

## Use a handoff to expose the difference

Have one session stop after defining an API contract. Ask the next session to continue within a bounded scope.

With ACC, the source records the handoff. The receiver verifies the artifacts and replies with the work it accepts and its first step. An acknowledgement establishes receipt, not a machine-enforced task ownership transition.

For the alternative, evaluate its documented acceptance workflow against the same situation. Record what happens if the receiver declines or both sessions act on an old view.

## Keep delivery separate from work state

A useful task record does not establish that an idle client can receive it immediately. Inspect the receiving surface, its activation requirements, and the live or pull path for the sessions you actually run.

For ACC, use [the compatibility matrix](/compatibility/) and [message delivery guide](/guides/message-delivery/). Opted-in experimental delivery remains distinct from durable storage.

## Make the choice fit the existing process

If your tracker already owns assignments and you want agents to ask and answer each other across clients, begin with [ACC's first exchange](/guides/connect-ai-coding-sessions/).

If explicit task transitions belong inside the shared coordination layer, include that requirement in your trial. The decision is about the state you want the system to maintain.

## Sources

- [When ACC fits](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/WHY_ACC.md)
- [ACC concepts](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/CONCEPTS.md)
- [ACC architecture](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/ARCHITECTURE.md)
- [Concord MCP project documentation](https://github.com/Get-Concord-AI/concord-mcp)
