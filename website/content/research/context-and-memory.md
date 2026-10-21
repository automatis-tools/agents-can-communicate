---
id: "context-and-memory"
title: "A message is not a shared memory"
description: "Understand what an ACC message or handoff preserves, why it does not merge model conversations, and how to keep continuation context useful."
route: "/research/context-and-memory/"
type: "research"
order: 20
status: "reviewed"
language: "en"
author: "ACC project"
lastVerified: "2026-10-21"
accVersion: "0.11.1"
evidenceLevel: "architecture-review"
---

# A message is not a shared memory

Two sessions discussing the same feature can still know different things. A message narrows that gap by recording something one participant deliberately tells another.

It does not make their conversation histories identical. That smaller promise is useful: the recipient gets a specific statement it can attribute, question, and verify.

## Record what another session can use

A useful message names a concrete fact and points to its evidence. For an interface, that might be the response schema and the file where it is implemented. For a review, it might be the exact revision and a reproducible failure.

The receiving agent can read the relevant artifact instead of accepting the message as current truth. This also makes corrections manageable. A changed decision can explicitly replace an older one while preserving who recorded both positions.

## Keep a handoff explicit

Before a session stops, it can record a handoff: what it reports as completed, decisions made, remaining work, verification, and blockers.

The next session checks that packet against the files and the user's authorized scope. A handoff can preserve a result that would otherwise be lost between clients, but it cannot recover details the source never recorded.

The timing matters. Prepare a checkpoint while the source model can still act. A model already stopped by a usage limit cannot create a new summary of its unavailable conversation.

See the [handoff guide](/guides/handoff-after-rate-limit/) for a practical work packet.

## Separate receipt from understanding

Durable storage establishes that a message exists. An accepted transport offer establishes that bytes crossed a boundary. An inbox read establishes retrieval.

None establishes that a model understood the request or completed the work.

For a question, look for a substantive answer. For requested work, inspect the returned artifact and its checks. The [delivery guide](/guides/message-delivery/) explains ACC's four receipt states.

## Understand the local boundary

ACC stores coordination data on the local machine, outside project repositories. It does not collect or share raw session transcripts.

An explicitly written message can still enter the receiving model's context through that client's provider. Local coordination does not mean local model inference.

The useful boundary is therefore deliberate sharing between independent sessions. Share the contract, decision, finding, or checkpoint needed for the next action, and preserve the recipient's ability to evaluate it.

## Sources

- [Messages, receipts, decisions, and handoffs](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/CONCEPTS.md)
- [Storage and delivery architecture](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/ARCHITECTURE.md)
- [Security model](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/SECURITY_MODEL.md)
