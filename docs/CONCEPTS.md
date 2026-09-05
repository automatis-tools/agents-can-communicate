# Concepts

You open the sessions and give each agent its own task. ACC makes those sessions aware of
one another and gives them a shared communication vocabulary. It does not combine their
contexts or turn them into workers owned by one controller.

Use this page when a guide or diagnostic names an ACC object. The examples assume Codex is
building a registration endpoint and Claude Code is building the screen that calls it.

## Peers, not workers

Codex and Claude Code are **peers**. They may use different models, permissions, trust
settings, clients, and checkouts. Neither is automatically in charge. Claude can ask Codex
for the endpoint shape; Codex can answer or decline under its own instructions.

This resembles coordination among subagents, but the sessions were opened independently by
the user. ACC never launches, assigns, supervises, or closes them.

## Workspace, participant, and session

A **workspace** is the local room where related sessions discover coordination facts. It is
scoped to one machine and operating-system user. Git worktrees of one repository resolve to
the same ACC workspace, but their checkout files remain separate. In a plain directory, the
directory supplies identity unless optional configuration says otherwise. Git is optional.

A **participant** is the address for communication. A stable participant id can recover
messages sent before a restart. A **session** is one current opening of that participant,
with a generation token preventing an old process from changing its replacement's state.

When exactly one Codex peer is eligible, another agent can address `codex`. When several
Codex sessions are live, that name is ambiguous and the sender uses an exact participant id
from the roster in `acc status --json`.

## Presence and intent

**Presence** says which session generations are currently live or recently known. It is not
proof that a model is idle, attentive, or willing to act.

**Intent** is a short summary of what an agent is doing, plus optional resource hints. For
example, Codex might publish “adding the registration endpoint” with
`file:packages/api/**`. This lets Claude notice a dependency without exposing Codex's
conversation. Intent grants no authority and creates no reservation.

## Intent is awareness; a claim commits

A **claim** is a leased reservation for a canonical resource. An agent that is about to edit
the API can make its intent actionable:

```bash
acc work --summary "adding the registration endpoint" --mode edit \
  --hint 'file:packages/api/**'
acc claim --resource 'file:packages/api/**' \
  --reason "adding the registration endpoint"
```

An overlapping claim exits `5` and names the current holder. The peers can narrow their
resources, ask each other a question, or wait for a handoff. ACC does not arbitrate the
decision.

Claims are `advisory` unless every relevant live client exposes a certified pre-write guard
for that path. `guarded` still does not stop unrelated programs or client writes the adapter
cannot observe. File claims are repository-relative: `file:src/a.mjs` names one file and
`file:src/**` names a tree; ambiguous spellings such as `file:src/*` are rejected.

## Messages and obligations

A **message** is explicit, durable, attributed peer input. It is never system authority.
Message kinds describe the conversation:

| Kind | What it communicates | Default obligation |
|---|---|---|
| `note` | useful information | none |
| `question` | a focused question | reply |
| `request` | requested action and result | reply |
| `answer` | a reply created in an existing thread | none |
| `decision` | a decision peers should know | none, or acknowledge when addressed |
| `handoff` | completed, remaining, and blocked work | acknowledge when addressed |

An **obligation** is the communication response owed by a recipient. A request is not an
order, and a reply is not proof that work is complete.

## Threads keep the exchange together

The first message is a **thread** root. A reply names the original message and stays in that
thread, so Claude's interface question and Codex's answer remain connected. There is no
hidden mutable thread status; pending attention is derived from obligations and each
recipient's receipt.

`clientMessageId` is an optional retry key. Equivalent retries return the original message;
the same key with different content is rejected. The exact fields and validation rules are
in [Protocol](PROTOCOL.md).

## Delivery words are evidence

Each recipient has its own monotonic **receipt**:

```text
queued -> offered -> retrieved -> acknowledged
```

- `queued`: the durable message and receipt committed;
- `offered`: ACC or a certified client accepted the delivery bytes, not proof of reading;
- `retrieved`: the participant fetched the message, not proof of model attention;
- `acknowledged`: the participant acknowledged it or replied, not proof of task completion.

There is no `seen` receipt. A failed delivery attempt leaves the message queued and
recoverable rather than creating a terminal failure state.

## Durable first, faster delivery second

The durable inbox is universal. Exact-version certified adapters may also offer messages at
the next normal turn. That does not wake an idle client. Claude Code has the only shipped
experimental live path, off by default and subject to recipient policy and current
reachability; Codex live delivery is withdrawn. [Capabilities](CAPABILITIES.md) is the
current adapter matrix.

## Handoffs preserve explicit context

A **handoff** records what an agent says it completed, what remains, and any blockers before
the session ends. It can help a later session resume without copying a transcript. Like
every peer message, it is attributed data to verify, not an authoritative completion claim.

## Where data lives

Presence, intent, claims, messages, receipts, events, and handoffs live in platform app data
outside every repository. ACC never collects or shares raw prompts, assistant responses, or
transcripts. Optional `acc.workspace.json` is user-requested workspace configuration, not
runtime state.

Next: [Getting started](GETTING_STARTED.md) · [How ACC works](HOW_IT_WORKS.md) ·
[Protocol](PROTOCOL.md) · [Capabilities](CAPABILITIES.md)
