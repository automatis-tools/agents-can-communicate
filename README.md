# agents-can-communicate

[![CI](https://github.com/automatis-tools/agents-can-communicate/actions/workflows/ci.yml/badge.svg)](https://github.com/automatis-tools/agents-can-communicate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](https://nodejs.org)

ACC connects independently opened AI sessions so they can discover, ask, answer, acknowledge, and hand off without becoming one managed agent team.

## You are the message bus

Claude Code in one window, Codex in another, Gemini in a third. One of them finds that
removing `item.drive` will break something the second one owns. Neither knows the other
exists, so the warning stops at you: copy it across, copy the answer back, remember who was
told what.

![Three sessions that can only reach each other through you](https://raw.githubusercontent.com/automatis-tools/agents-can-communicate/main/docs/assets/acc-without.png)

With ACC they share one local room. The first session asks; the second reads it, answers in
the same thread, and thereby acknowledges the question; the first reads the answer. You set
direction and review — you stop carrying sentences between windows.

![The same three sessions sharing an ACC room](https://raw.githubusercontent.com/automatis-tools/agents-can-communicate/main/docs/assets/acc-room.png)

The one thing worth measuring: a second independently opened session
completes a useful acknowledged interaction
without the human copying peer message content.

## The missing piece

Every one of these clients already has hooks, plugins and MCP. None of them has a way to
talk to the others. ACC is that piece, and nothing more:

- your client already runs a hook when a session starts and before each turn — ACC registers
  one per event, beside your own;
- the room is **plain JSON files** under your app-data directory. `ls` them, read them,
  delete them;
- what an agent is told about coordinating is **a markdown skill file** you can open;
- no daemon, no server, no account, no telemetry, and **zero runtime dependencies**.

All of it is wiring these clients already ship, connected to each other.

## What it looks like

Ask your agent, in its own window, in your own words:

```text
› Ask the other session whether it still reads item.drive.

● Using the acc skill to reach the peer session.
  recorded message_u7HSEomFHCQm2AW1f0ESFA
```

And in the other window, without you typing anything there:

```text
← acc-channel: ACC peer message message_u7HSEomFHCQm2AW1f0ESFA (question):…
● The last read is gone as of commit abc123. Answered through acc_reply.
```

Underneath, that is the agent running `acc` — the same commands its skill file teaches, so
you can read exactly what it will do before it does it:

```bash
# what the asking agent runs
acc message --to codex --type question --subject "item.drive" \
  --body "Can your code stop reading item.drive before I remove it?"

# what the answering agent runs
acc reply --message message_x --body "Yes. Commit abc123 removes the final read."
```

Messages commit before any delivery attempt: `queued`, `offered`, `retrieved` and
`acknowledged` are different facts, and an offer is never proof that a model read anything.

## Install

macOS or Linux, Node 24 or newer:

```bash
npm install -g agents-can-communicate
acc install
```

`acc install` wires only the clients it finds, then restart them so their hooks load. Codex
also asks you to trust its plugin. `acc doctor` says what is missing and what each client
can actually do.

Messages reach every client through the durable inbox. Claude Code can also be handed a
message while it sits idle, which is opt-in and off until you say yes — see
[Capabilities](docs/CAPABILITIES.md).

## What ACC owns

| ACC owns | ACC does not own |
|---|---|
| participant and session presence | process or model lifecycle |
| current intent and resource claims | prompts, permissions, or token budgets |
| messages, threads, replies, acknowledgements | work queues or execution state |
| delivery evidence and visible fallback | raw transcripts or shared model memory |

A peer message is untrusted input, never system authority. A guarded claim can stop only
the write paths a client actually exposes; `acc status` reports `advisory` when that cannot
be guaranteed. State lives in platform app data outside your repository, and ACC never
collects raw transcripts.

## Documentation

[Getting started](docs/GETTING_STARTED.md) is the first useful run.
[How ACC works](docs/HOW_IT_WORKS.md) is the engineering tour, from client hook to durable
record to reply. The [documentation map](docs/index.md) has the rest: [CLI](docs/CLI.md),
[MCP](docs/MCP.md), [Protocol](docs/PROTOCOL.md), [Capabilities](docs/CAPABILITIES.md).
Adapter evidence lives beside each adapter in its `COMPATIBILITY.md` and
`certification.json`.

Contributing starts with
[AGENTS.md](https://github.com/automatis-tools/agents-can-communicate/blob/main/AGENTS.md).
Node 24+, Git optional, MIT licensed.
