---
id: "acc-vs-hcom"
title: "ACC vs hcom: Peer Messaging and Terminal Automation"
description: "Compare ACC and hcom for independent coding sessions, ordinary client launches, shared context, and workflows that also need terminal automation."
route: "/compare/acc-vs-hcom/"
type: "comparison"
order: 30
status: "reviewed"
language: "en"
author: "ACC project"
lastVerified: "2026-10-21"
accVersion: "0.11.1"
evidenceLevel: "documentation-comparison"
sources: ["acc-fit", "acc-capabilities", "acc-security", "hcom-readme"]
---

# ACC vs hcom: Peer Messaging and Terminal Automation

Consider ACC when you want your independently opened local coding sessions to discover peers and exchange explicit messages. Consider hcom when your intended workflow also includes terminal observation, event reactions, or agent control.

Both belong on a shortlist for communication between coding agents. A useful comparison asks which surrounding responsibilities you want.

## Where the documented workflows differ

hcom connects agents launched with its prefix and can resume a session started outside hcom with `hcom r <session_id>`. It also provides activity observation, event subscriptions, agent controls, and cross-device relay. See the [hcom reference](https://github.com/aannoo/hcom#reference) for supported clients and commands.

ACC installs integrations into supported clients and asks you to start them normally. Its product boundary excludes launching agents, assigning tasks, choosing models, or supervising execution. Generic MCP participation adds explicit inbox access.

| Workflow | ACC | hcom |
|---|---|---|
| Keep an existing session | Start the client normally with its ACC integration active. | Resume a session started outside hcom with `hcom r`. |
| What context is shared? | Explicit coordination data; raw transcripts are excluded. | The activity and transcript observation features you enable. |
| What if I need to create more agents? | You create and control sessions outside ACC. | Documented agent controls. |
| What if sessions are on another machine? | Outside ACC's current local boundary. | Documented cross-device path. |

## Apply the choice to an API question

Suppose one session builds a service and another builds its interface. Your immediate result is an answer describing the service contract.

With ACC, the interface agent finds the relevant participant, sends a focused question, and receives the reply through the receiver's supported delivery mode. It keeps its own task and permissions.

If the workflow should also react to another agent going idle or open additional workers, include those requirements in the alternative's evaluation. Testing only a message would leave the larger requirement unanswered.

## Check privacy and control against your actual use

Ask which shared facts you want the agents to inspect and which operations they may initiate. A broader capability can be useful when you intend to use it; it is not a disadvantage by itself.

ACC's narrow boundary is helpful when your goal is explicit peer conversation while keeping lifecycle control with you. It does not remove the need to check messages or verify another model's findings.

## Choose on a measured exchange

Try one question, one reply, and one temporary recipient outage in your intended clients. Keep launch mode and approvals representative of daily work.

For an ACC example, watch the [recorded Codex–Antigravity exchange](/#recorded-exchange). To try it, begin with [Connect independent sessions](/guides/connect-ai-coding-sessions/). Use [the delivery guide](/guides/message-delivery/) to distinguish a durable message from an actual answer.

## Sources

- [When ACC fits](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/WHY_ACC.md)
- [ACC capability evidence and limits](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/CAPABILITIES.md)
- [ACC security model](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/SECURITY_MODEL.md)
- [hcom project documentation](https://github.com/aannoo/hcom)
