---
id: "gemini-cli"
title: "Connect Gemini CLI to Independent Coding Sessions"
description: "Use ACC with Gemini CLI next-turn delivery and a durable inbox. Keep its integration distinct from Antigravity CLI and desktop."
route: "/integrations/gemini-cli/"
type: "integration"
order: 50
status: "reviewed"
language: "en"
author: "ACC project"
lastVerified: "2026-10-21"
accVersion: "0.11.1"
evidenceLevel: "repository-review"
sources: ["acc-setup", "acc-capabilities", "gemini-evidence", "acc-mcp"]
---

# Connect Gemini CLI to Independent Coding Sessions

ACC includes a dedicated Gemini CLI adapter. A Gemini session can exchange questions and replies with independent sessions in other coding clients while keeping its own task and permissions.

Describe this as Gemini CLI support specifically. Antigravity CLI and Antigravity desktop have separate adapters or surface-specific contracts; their live-delivery evidence cannot establish a Gemini CLI wake capability.

## Activate the Gemini integration

~~~bash
acc install --adapter gemini_cli
~~~

Follow the client-specific activation instructions, trust the integration as required, and start a fresh session from the project directory.

Package-shipped next-turn certification starts at Gemini CLI 0.57.0. The retained captures identify the client, platform, hook event, and observed result.

Those are historical compatibility captures. Check the effective mode in your current installation after changing client versions or approval settings.

## Use next-turn delivery deliberately

Gemini CLI can receive complete peer messages at a normal turn under the captured integration contract. The repository does not certify an external idle wake or native reply-routing path.

The documented ACP launch option changes ownership of the client launch. Its existence is therefore insufficient evidence for waking an independently opened Gemini TUI session.

When you need a reply, give the Gemini session its normal next turn or ask it to read its inbox. The durable message remains available independently of a successful faster offer.

## Apply it to investigation

A focused example for Gemini:

> Investigate the failing registration case. Ask the service owner through ACC for the intended validation contract. Return the reproduction and evidence; do not modify the interface.

The service session can answer the question without taking over the investigation. Both agents retain their own instructions.

ACC's captured Gemini guard behavior also depends on which tools the client exposes and its approval mode. A successful integration does not mean every edit path is guarded.

## Verify the exchange

Inspect the participants from the project directory, establish which exact session should receive the question, and look for a substantive response.

If another tool only has MCP access, use its explicit inbox workflow rather than assuming Gemini's hooks apply to it.

Start with [Connect independent sessions](/guides/connect-ai-coding-sessions/) and use the [delivery guide](/guides/message-delivery/) when a queued message has not produced an answer.

## Sources

- [ACC setup](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/GETTING_STARTED.md)
- [ACC capability evidence and limits](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/CAPABILITIES.md)
- [ACC Gemini compatibility captures](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/packages/adapter-gemini-cli/COMPATIBILITY.md)
- [ACC MCP interface](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/MCP.md)
