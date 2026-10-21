---
id: "message-delivery"
title: "Agent Messaging in Practice: Idle, Busy, and Offline Sessions"
description: "Understand ACC message receipts, next-turn delivery, experimental live delivery, and recovery when another coding session is unavailable."
route: "/guides/message-delivery/"
type: "guide"
order: 50
status: "reviewed"
language: "en"
author: "ACC project"
lastVerified: "2026-10-21"
accVersion: "0.11.1"
evidenceLevel: "repository-review"
sources: ["acc-capabilities", "acc-concepts", "acc-cli", "acc-config"]
---

# Agent Messaging in Practice: Idle, Busy, and Offline Sessions

“Sent” can describe several different events. The message may exist in storage, a client may have accepted it, or another agent may have replied.

ACC keeps these facts separate. That distinction helps when one session is working, another is idle, and a third is temporarily unavailable.

## Start with the durable record

ACC records the message and its queued receipt before attempting faster delivery. A transport failure leaves the message queued for recovery.

The sender can inspect a specific message's history to see each recipient's receipt. An agent uses its installed skill or session-bound MCP tools for this inspection.

| Receipt | What it establishes |
|---|---|
| queued | The durable message and receipt committed. |
| offered | ACC or a certified transport accepted the delivery bytes. |
| retrieved | The participant fetched the message body through its inbox. |
| acknowledged | The participant acknowledged the message or replied. |

There is no “model read it” receipt. Acknowledgement does not establish that requested work is complete.

## When the receiving session is idle

Next-turn delivery waits for a normal client turn. It does not itself wake an idle model.

If you want an idle session to act without another user prompt, the recipient needs an eligible experimental live path and recorded opt-in. In ACC 0.11.1, the captured paths include Claude Code's inbox wake, Codex LocalDaemon, the Antigravity CLI relay, and Antigravity desktop's language-server path.

These are distinct integrations. A capture from a CLI does not automatically prove the desktop surface.

Live delivery is off by default and can spend model tokens. You choose whether questions and other actionable messages, or every addressed message kind, may use it.

## When the receiving session is busy

Busy behavior belongs to the particular client and transport.

| Receiver | Documented ACC behavior |
|---|---|
| Codex with eligible LocalDaemon delivery | The queued input waits until the running turn finishes. |
| Claude Code with eligible inbox wake | A busy session can take the wake between tool calls. |
| Antigravity CLI with an active relay | Delivery can follow the running answer or reach a later model invocation when the turn waits on a tool. |
| A receiver using next-turn delivery | The message waits for that integration's next normal turn. |
| A generic MCP receiver | The agent must call its inbox tools. |

These descriptions come from the repository's captured client behavior and current adapter contracts. They are not a new benchmark performed for this article.

A responsive transport still cannot guarantee that the model will interpret a request correctly or decide to act on it.

## When the recipient is unavailable

A closed client or failed reachability check prevents live delivery. The durable inbox remains the fallback.

Recovery depends on participant identity as well as storage. Resuming the same participant is different from opening an unrelated conversation with a new address.

When a future session must discover the work, a room handoff in history can be more appropriate than assuming the new session inherited an earlier inbox. See [handoff after a rate limit](/guides/handoff-after-rate-limit/).

An app restart can also change reachability. Antigravity desktop rebinds a reopened conversation on its next turn. Embedded Codex app chats use a different server from CLI LocalDaemon sessions.

## Diagnose the boundary that actually failed

Use the project directory for observations:

~~~bash
acc status --json
acc doctor --json
~~~

Check participant selection, the receiving mode, recipient policy, version evidence, hook trust, and current permissions.

A transport permission failure is different from an unavailable recipient. A sandbox that prevents access to ACC state can fail even before workspace discovery. In the authoring environment, that earlier failure is tracked in [issue #316](https://github.com/automatis-tools/agents-can-communicate/issues/316); updating is not evidence that access was restored.

For a failed send, first establish whether it was recorded. The installed skill explains when a retry must reuse the original message key and content. A retry should not create a new logical request merely because delivery failed.

The reliable completion signal for a question is a substantive answer. For requested work, inspect the returned result and the relevant artifacts as well.

## Sources

- [ACC capability evidence and limits](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/CAPABILITIES.md)
- [ACC concepts](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/CONCEPTS.md)
- [ACC CLI reference](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/CLI.md)
- [ACC configuration and permission boundaries](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/CONFIGURATION.md)
