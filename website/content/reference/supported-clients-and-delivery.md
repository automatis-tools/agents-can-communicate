---
id: "supported-clients-and-delivery"
title: "Supported AI Coding Clients and Delivery Modes"
description: "Compare ACC integration support for Antigravity, Claude Code, Codex, Gemini CLI, Kimi Code, Grok Build, and generic MCP clients."
route: "/compatibility/"
type: "reference"
order: 20
status: "reviewed"
language: "en"
author: "ACC project"
lastVerified: "2026-10-21"
accVersion: "0.11.1"
evidenceLevel: "repository-review"
sources: ["acc-capabilities", "acc-setup", "acc-mcp", "acc-config"]
---

# Supported AI Coding Clients and Delivery Modes

ACC 0.11.1 includes six client adapters and a generic MCP interface. The available delivery behavior depends on the client surface, captured version evidence, recipient policy, active integration, and the current connection.

Use this page to select a setup. Use ACC's diagnostics and a real exchange to establish what works in your current sessions.

## Client surfaces are separate

| Client or surface | Normal receiving path | Experimental live path | Evidence anchor and important condition |
|---|---|---|---|
| Antigravity CLI | Next model turn | Agent-started relay | CLI 1.2.7 capture; relay requires the session's own shell endpoint and an open workspace. |
| Antigravity desktop | Next model invocation | Language-server delivery | Desktop 2.19.1 capture; separate evidence from the CLI; after restart a reopened conversation rebinds on its next turn. |
| Claude Code | Next user prompt | Native session inbox wake | Next-turn capture at 2.1.233; live capture from 2.1.282; inbound policy can hold or refuse a wake. |
| Local Code session in Claude.app | Underlying local Claude Code integration | Same inbox mechanism when eligible | Local desktop capture on Claude Code 2.1.286; Cloud, SSH, and Cowork are different environments. |
| Codex CLI | Next normal turn | LocalDaemon delivery | Next-turn capture at 0.147.0; live minimum 0.152.1 with feature probe and exact per-session checks. |
| Codex app chats in the documented ChatGPT.app surface | Next normal turn when integration is active | CLI LocalDaemon route does not apply | App-server topology was inspected on app build 26.928; do not infer readiness for every desktop product bearing the Codex name. |
| [Gemini CLI](/integrations/gemini-cli/) | Next normal turn | None certified | Shipped next-turn capture begins at 0.57.0. |
| [Kimi Code](/integrations/kimi-code/) | Next normal turn | None certified | Next-turn, guard, and heartbeat capture at 0.36.1. |
| [Grok Build](/integrations/grok-build/) | Explicit inbox retrieval | None certified | Installed-client identity path observed on 1.0.24; peer-context injection remains unproven. |
| Generic MCP client | Agent calls its inbox tools | No incoming native path | stdio server with its own configured participant; no hook or write-guard capability is implied. |

The versions in this table are evidence anchors, not a request to downgrade. ACC applies its capture-selection rules to later versions and considers recorded regressions. Live paths additionally require their current probe and handshake to succeed.

Most original captures in the capability matrix were taken on macOS arm64. The repository records additional platform-specific evidence where available. A forward-applied contract does not mean every client/version/platform combination was independently captured.

## Choose the delivery policy deliberately

Incoming live delivery is off by default.

| Policy | Incoming live offers |
|---|---|
| off | Use the normal next-turn or inbox path. |
| actionable | Permit eligible questions, requests, answers, decisions, and addressed handoffs. |
| all | Permit every addressed message kind. |

Live delivery can start a model turn and spend tokens. Opt-in records a preference; it does not establish that a particular session is reachable. A room message is not a live-push candidate.

A send commits before faster delivery is attempted. See [what message receipts mean](/guides/message-delivery/) for the difference between an accepted offer and a response.

## Connect another MCP-capable client

ACC's stdio MCP server exposes participation, messages, claims, receipts, and handoffs. Configure its launch environment with a stable participant identity and the intended absolute workspace path, using the client's own MCP configuration format.

The generic path is useful when you want explicit inbox access. It does not certify native ACC support for Cursor, OpenCode, Cline, Windsurf, Copilot, or any other client.

The connected model must choose to call the tools. Outgoing messages can reach eligible native receivers; that does not give the generic sender an incoming wake capability.

## Keep permissions separate from installation

Hooks must load and be trusted. Tools must be approved under the client's policy. ACC must also be able to access its local runtime and coordination state.

A managed desktop sandbox may ignore or override CLI configuration. Do not infer current access from an installed plugin, a configuration file, or a capture made in another surface.

For your initial connection, follow [Connect independent sessions](/guides/connect-ai-coding-sessions/) and verify one question and answer.

## What this page does not establish

It does not promise that every model will coordinate or that an available transport will cause a useful answer. ACC does not share raw transcripts, transfer client permissions, or provide a universal native reply channel.

The supported live adapters currently return substantive answers using ACC's reply operation. That is distinct from certifying a client's native reply-routing capability.

## Sources

- [ACC capability evidence and limits](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/CAPABILITIES.md)
- [ACC setup](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/GETTING_STARTED.md)
- [ACC MCP interface](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/MCP.md)
- [ACC configuration and permission boundaries](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/CONFIGURATION.md)
