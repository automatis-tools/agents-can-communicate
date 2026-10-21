---
id: "claude-code"
title: "Connect Claude Code to Independent Coding Sessions"
description: "Use ACC to exchange questions, reviews, and handoffs between Claude Code and sessions in other coding clients."
route: "/integrations/claude-code/"
type: "integration"
order: 10
status: "reviewed"
language: "en"
author: "ACC project"
lastVerified: "2026-10-21"
accVersion: "0.11.1"
evidenceLevel: "repository-review"
sources: ["acc-setup", "acc-capabilities", "claude-evidence", "claude-native"]
---

# Connect Claude Code to Independent Coding Sessions

Claude Code already has its own cross-session messaging. If every session in your workflow is Claude Code, try that native feature first.

ACC becomes useful when a Claude Code session needs to talk to an independent session in another client: Antigravity, Codex, Kimi Code, Gemini CLI, or a participant using explicit inbox access.

Each side keeps its own conversation and permissions. A message supplies context rather than authority.

## Activate the integration

~~~bash
acc install --adapter claude_code
~~~

Complete the installation instructions and start a new Claude Code session in the project. Trusted hooks provide the session's own ACC identity and coordination context.

The next-turn evidence was captured on Claude Code 2.1.233. That receiving path waits for a user prompt. It does not itself wake an idle session.

## Choose whether idle sessions may wake

Experimental live delivery uses the inbox Claude Code opens for its session. The captured minimum is 2.1.282. Start Claude Code with the ordinary command; ACC does not require a launcher wrapper for this path.

An idle wake starts a turn. A busy receiver can take it between tool calls. Inbound policy matters: a bypass-permissions session can hold each wake for approval unless its cross-session inbound setting accepts it. A refusal can drop wakes.

Live delivery requires recorded opt-in and may spend model tokens.

## Distinguish Claude.app surfaces

The repository includes a capture of a local Code session in Claude.app using the same inbox mechanism on Claude Code 2.1.286.

Cloud, SSH, and Cowork sessions are not the same local execution environment. ACC's boundary is one machine and operating-system user; native Claude messaging has its own scope.

## Ask for a peer review

For a Claude Code implementer:

> Ask the available Kimi or Codex review session through ACC to inspect the identified change. Include the exact checkout and revision. Request blocking defects with evidence, then verify the findings before editing.

See the [full review workflow](/guides/code-review-between-ai-clients/) for target selection and follow-up.

If your need is specifically to call Codex from inside Claude Code, also consider the [official Codex plugin](/compare/acc-vs-codex-plugin/). ACC addresses the broader workflow of sessions you run separately.

## Sources

- [ACC setup](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/GETTING_STARTED.md)
- [ACC capability evidence and limits](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/CAPABILITIES.md)
- [ACC Claude Code compatibility captures](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/packages/adapter-claude-code/COMPATIBILITY.md)
- [Claude Code cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)
