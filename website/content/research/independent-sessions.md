---
id: "independent-sessions"
title: "Independent sessions, shared conversation"
description: "Why keeping each AI coding session's context and permissions matters when connecting clients, and what a shared communication layer should own."
route: "/research/independent-sessions/"
type: "research"
order: 10
status: "reviewed"
language: "en"
author: "ACC project"
lastVerified: "2026-10-21"
accVersion: "0.11.1"
evidenceLevel: "architecture-review"
---

# Independent sessions, shared conversation

A coding session can know a service deeply without knowing what another session is building against it. Combining their entire conversations is one possible response. A direct question is often a smaller, more useful one.

The distinction matters because a session holds more than knowledge. It has permissions, a checkout, a current goal, and a conversation with its user.

## Keep the useful differences

Suppose Codex is changing a service while Claude Code builds its interface. The service session can answer an interface question from the code it is already working on. The interface session can use that answer while retaining its own task and constraints.

They do not need a common lead agent for that exchange. Each needs an address for the other, a way to ask, and a reply it can inspect.

That is the boundary ACC chooses. The user opens sessions and assigns work. ACC introduces the participants and records their communication.

## Share facts before sharing authority

A message can describe a proposed API contract, a finding, or unfinished work. It remains input for the recipient to evaluate.

An agent asking a peer to edit a file has not granted the permissions needed to edit it. Nor has the sender acquired authority over the receiving session's user.

This is why ACC frames peer messages as attributed, untrusted input. An independent session keeps responsibility for deciding which instructions apply.

## Let the existing process keep its job

The issue tracker can continue to own the backlog. Git can continue to own branches and commits. Client settings can continue to own model access and approval rules.

The shared conversation connects these existing tools when one piece of work depends on another. It does not need to become another project-management system.

This narrower choice also has a cost. ACC does not choose the next worker, supervise execution, or make every model notice every dependency. A workflow that needs those responsibilities should evaluate a layer designed to own them.

## Ask a question that earns the connection

The first useful question is usually small:

> Which validation errors does the registration endpoint return, and which fields do they belong to?

A useful reply identifies the contract and its source. The recipient can check that source and continue.

Start with [one exchange between independent sessions](/guides/connect-ai-coding-sessions/). If you are deciding between different coordination models, read the [workflow comparison](/compare/agent-communication-tools/).

## Sources

- [ACC concepts and session independence](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/CONCEPTS.md)
- [When ACC fits](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/WHY_ACC.md)
- [Trust boundaries](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/SECURITY_MODEL.md)
