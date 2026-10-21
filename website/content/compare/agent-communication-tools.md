---
id: "agent-communication-tools"
title: "AI Coding Agent Communication Tools: Choose by Workflow"
description: "Compare local peer messaging, agent mailboxes, terminal automation, native client messaging, and delegation before choosing an agent communication tool."
route: "/compare/agent-communication-tools/"
type: "comparison-hub"
order: 10
status: "reviewed"
language: "en"
author: "ACC project"
lastVerified: "2026-10-21"
accVersion: "0.11.1"
evidenceLevel: "documentation-comparison"
sources: ["acc-fit", "acc-capabilities", "hcom-readme", "agent-mail-readme", "concord-readme", "codex-plugin-readme", "claude-native", "relaycast-api"]
---

# AI Coding Agent Communication Tools: Choose by Workflow

The right communication tool depends on which sessions you want to connect and how much responsibility you want the connecting layer to take.

A mailbox, a terminal workflow, an in-client delegation plugin, and a native messaging feature can all move text. They need not preserve the same session ownership, store the same context, or reach the same receivers.

## Begin with a concrete question

For independent local sessions, try this question:

> Can my interface session ask the service session I already opened for its API contract, then use the answer without me copying it between windows?

For another workflow, the question may instead be whether one agent can launch new workers, whether a human can search a shared archive, or whether sessions on different machines can communicate.

Choose the requirement before comparing features.

## A practical shortlist

| Tool or approach | Documented emphasis | Evaluate it when |
|---|---|---|
| Agents Can Communicate | Local peer awareness, durable messages, receipts, and handoffs across independent client sessions. | You want to keep separately opened sessions and their existing permissions. |
| hcom | Cross-terminal messaging with activity observation, events, agent control, and cross-device relay. | You also want terminal automation and visibility into agent activity. |
| MCP Agent Mail, Rust implementation | Persistent mail-style coordination with search, an archive, reservations, and operator interfaces. | A shared mailbox and inspection workflow are central to your use. |
| Concord MCP | Local messaging plus explicit task context, ownership transitions, handoffs, and review state. | The shared record should track the work's lifecycle as well as its messages. |
| Official Codex plugin for Claude Code | Codex review, delegation, transfer, and background jobs initiated inside Claude Code. | Your workflow starts in Claude Code and invokes Codex from there. |
| Claude Code native messaging | Messaging among a user's Claude Code sessions, including documented remote scenarios. | Your participating sessions all use Claude Code. |
| Agent Relay | Messaging infrastructure with channels, DMs, threads, and hosted or self-hosted engine options. | Deployment scope and communication infrastructure are part of the requirement. |

Start with the row that matches the work you want your sessions to share. Then try that workflow in your own clients.

## Compare the same receiving conditions

Test an idle receiver, a receiver in a running turn, and a receiver that is temporarily unavailable.

For each condition, establish what happened: recorded, accepted by a transport, retrieved, or answered. Products can use different terms, so compare the underlying observation rather than matching labels.

ACC keeps queued, offered, retrieved, and acknowledged distinct. Its live paths are experimental, require recipient opt-in, and depend on the particular client surface. See [compatibility](/compatibility/).

ACC reports CLI and desktop delivery capabilities separately. Check the surface you actually use.

## Inspect the data boundary

Ask which information enters shared storage. A short intentional message, a task packet, a transcript, and a terminal observation are different kinds of data.

ACC excludes raw transcripts and keeps its runtime state outside repositories. Models can still receive the message through their coding providers; local coordination does not make the models run locally.

Decide what your workflow needs to retain before choosing an observation or archive feature.

## Keep ordinary setup in the comparison

Count the client activation and trust steps, not just installation of the connecting package. Check whether your actual desktop sandbox permits access to local state and whether client upgrades affect the integration.

A documented capability is evidence about a product contract. A successful exchange from your installed setup establishes that the current path works.

Watch a [recorded Codex–Antigravity exchange](/#recorded-exchange) for an ACC example with client versions and delivery events. Then [connect two sessions and obtain one useful answer](/guides/connect-ai-coding-sessions/) in your own setup.

## Read the focused comparisons

- [ACC and hcom](/compare/acc-vs-hcom/)
- [ACC and MCP Agent Mail](/compare/acc-vs-mcp-agent-mail/)
- [ACC and Concord MCP](/compare/acc-vs-concord-mcp/)
- [ACC and the official Codex plugin](/compare/acc-vs-codex-plugin/)

## Sources

- [When ACC fits](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/WHY_ACC.md)
- [ACC capability evidence and limits](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/CAPABILITIES.md)
- [hcom project documentation](https://github.com/aannoo/hcom)
- [MCP Agent Mail Rust project documentation](https://github.com/Dicklesworthstone/mcp_agent_mail_rust)
- [Concord MCP project documentation](https://github.com/Get-Concord-AI/concord-mcp)
- [Official Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc)
- [Claude Code cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)
- [Agent Relay Relaycast API reference](https://agentrelay.com/docs/relaycast-api)
