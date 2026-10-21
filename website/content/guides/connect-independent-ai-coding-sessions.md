---
id: "connect-independent-ai-coding-sessions"
title: "How to Connect Independent AI Coding Sessions"
description: "Connect AI coding sessions across clients with ACC. Keep each session independent while sharing questions, replies, and handoffs."
route: "/guides/connect-ai-coding-sessions/"
type: "guide"
order: 10
status: "reviewed"
language: "en"
author: "ACC project"
lastVerified: "2026-10-21"
accVersion: "0.11.1"
evidenceLevel: "repository-review"
sources: ["acc-setup", "acc-concepts", "acc-capabilities", "acc-security"]
---

# How to Connect Independent AI Coding Sessions

Two coding sessions can work on the same feature while knowing different things. One changes an API. Another builds the screen that calls it. A useful connection lets the second session ask about the interface and bring the answer back into its own work.

Agents Can Communicate, or ACC, adds that connection between independent local sessions. You choose the clients, start the sessions, and decide their work. ACC supplies local discovery, messages, replies, and handoffs.

The useful first result is one question answered by the right peer. Start there before dividing a whole project among agents.

## Choose the sessions you actually use

ACC has adapters for Antigravity, Claude Code, Codex, Gemini CLI, Grok Build, and Kimi Code. Their delivery modes differ. A generic MCP client can participate through an inbox that the agent checks.

Pick two clients you already have installed on the same machine, under the same operating-system user. For example, use Antigravity for the interface and Kimi Code for a service change. Claude Code and Codex are another combination, rather than a required pair.

Check [client compatibility](/compatibility/) before expecting an idle session to wake. An integration, a next-turn message, and experimental live delivery are different capabilities.

## Install ACC and activate the integrations

ACC requires Node.js 24 or newer. It supports macOS, Linux, and Windows 10/11.

~~~bash
npm install -g agents-can-communicate
acc install
~~~

Follow the activation instructions for the clients the installer finds. Restart them from the project directory. Complete the client's own hook or plugin trust review when requested.

For the first exchange, the default delivery behavior is sufficient if you are present to give the receiver its next turn or ask it to check its inbox. Experimental live delivery is a separate opt-in that can start a model turn and spend tokens.

## Give each session a concrete part of one feature

Use a small feature with an obvious shared dependency:

| Session | Task |
|---|---|
| Service session | Add account registration and define its request, response, and error cases. |
| Interface session | Build the registration form against the service contract. |

Give each session its own ordinary task. Supported hooks introduce peer awareness and install coordination instructions. Models still decide when a peer is relevant.

If you want an explicit first exchange, tell the interface session:

> Ask the service session through ACC for the registration request, response, and validation errors. Use its answer when implementing the form. Keep your work within the interface.

Tell the service session:

> Answer the interface session's ACC question with the current contract. Identify anything still undecided.

These are example prompts, not a transcript of a measured run.

## Verify discovery before assuming a message arrived

From the project directory, inspect the roster:

~~~bash
acc status --json
~~~

Look for both participants and their work. If several sessions use the same client, the agent must select an exact participant from the roster. A client name alone cannot choose safely between them.

If a peer is missing, check the launch directory, hook trust, integration activation, and current permissions. Git worktrees of one repository share an ACC workspace; unrelated directories do not automatically share one.

The [setup documentation](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/GETTING_STARTED.md) explains client-specific activation. A diagnostic report should describe your actual session rather than assume that installation made it ready.

## Look for a substantive answer

ACC records a message before attempting faster delivery. The receipt can then advance through queued, offered, retrieved, and acknowledged.

An offer means the transport accepted the message. It does not establish that the model considered the question. The result you want is an answer that names the agreed contract, the remaining uncertainty, and the artifact to check.

Each receiver keeps its own permissions and instructions. A peer request supplies context; it does not grant new authority.

## Use the connection for the next dependency

Once the first exchange works, use the same channel for [independent review](/guides/code-review-between-ai-clients/), [coordination across worktrees](/guides/ai-agents-git-worktrees/), or a [handoff to another client](/guides/handoff-after-rate-limit/).

ACC does not merge conversation histories or choose a lead agent. Its role is to let the sessions you already chose communicate while you retain control of the work.

## Sources

- [ACC setup](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/GETTING_STARTED.md)
- [ACC concepts](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/CONCEPTS.md)
- [ACC capability evidence and limits](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/CAPABILITIES.md)
- [ACC security model](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/SECURITY_MODEL.md)
