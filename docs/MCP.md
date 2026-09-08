# MCP

Use `acc-mcp` when a client can call MCP tools but has no native ACC adapter. The server
exposes durable messages, threads, receipts, intent, claims, and handoffs over stdio. It is
a manual polling integration: it cannot infer the client's lifecycle, intercept writes,
inject a normal turn, or push a message.

```mermaid
graph LR
  C["independently opened MCP client"] -->|"stdio JSON-RPC"| M["acc-mcp"]
  M --> S[("ACC durable store")]
```

## Configure the server

```json
{
  "command": "acc-mcp",
  "env": {
    "ACC_MCP_PARTICIPANT": "research",
    "ACC_MCP_WORKSPACE": "/absolute/path/to/project"
  }
}
```

`acc-mcp` accepts no command-line arguments. `ACC_MCP_PARTICIPANT` is the stable recipient
identity for this server. It comes from user-owned launch configuration, never from MCP
`initialize` or `clientInfo`. `ACC_MCP_WORKSPACE` should be absolute; without it, the
server uses its launch directory, which may be a different workspace from the other
sessions.

The server supports initialized MCP clients using `2025-06-18` or `2025-11-25`, and
the per-request metadata interface in `2026-07-28`, over newline-delimited JSON-RPC stdio.
Initialized clients send `initialize`, accept the negotiated revision, then send
`notifications/initialized` before calling tools. Unknown initialization revisions receive
`2025-11-25`; the client decides whether it supports that revision. Transport initialization
does not create an ACC participant: a tool call or inbox resource read resolves it.

Tool input schemas are closed: unknown fields and invalid conditional shapes are
rejected before a session is resolved. Approve the ACC tools through your client's normal
permission controls. A headless client configured to reject approval requests can connect
successfully yet refuse tool calls; that is distinct from a protocol handshake failure.

## Call the durable tools

| Tool | Required input | Optional input |
|---|---|---|
| `acc_status` | — | — |
| `acc_sync` | — | `cursor`, `scope: delta|full|history`, `limit: 1..500`, `kind`, `messageId`, `current` |
| `acc_work` | `summary` and `mode`, or `clear: true` | `state`, `resourceHints` |
| `acc_claim` | `action`; `resource` for acquire, `claimId` for renew | `mode`, `reason`, `leaseSeconds` where valid |
| `acc_release` | `claimId` | — |
| `acc_message` | `to`, `subject`, `body` | `kind`, `obligation`, `clientMessageId`, `supersedes`, `withdraws` |
| `acc_request` | `toParticipantId`, `title` | `detail`, `clientMessageId` |
| `acc_inbox` | — | `messageId`, `cursor`, `limit: 1..500` |
| `acc_reply` | `messageId`, `body` | `subject`, `clientMessageId` |
| `acc_ack` | `messageId` | — |
| `acc_finish` | `goal` | `status`, `completed`, `remaining`, `blockers`, `toParticipantId`, `clientMessageId` |

All tool names above are the complete model-facing surface. There are no execution or
client-control tools.

Send-like tools return a raw structured object with `{ message, delivery }`; their text
content is the JSON serialization of the same value. Default `acc_inbox` returns
`{items, nextCursor}`: read-only pending message summaries paired with receipts, newest
first. It never retrieves bodies. Pages default to 20 items, at most 12,000 bytes of
formatted page JSON before MCP framing. `cursor` is the complete message id from
`nextCursor`; omit it on a new poll to see arrivals. Reading or acknowledging the anchor
between pages does not shift continuation. The summary field allowlist, byte limit,
and live-page semantics are described in [CLI](CLI.md#inbox-reply-and-acknowledgement).

With an exact `messageId`, `acc_inbox` returns a one-item array with the complete
message/receipt pair and advances only that participant's receipt to `retrieved` when
needed. Exact acknowledged inspection preserves receipt state, timestamp, and event
history. Do not combine `messageId` with cursor or limit. Resolved mail stays out of lists.
`acc_reply` writes an `answer` and acknowledges the original atomically. It additionally
returns `receipt` for that original message; `message` and `delivery` describe the outgoing
answer. `acc_ack` exposes no receipt-state parameter.

For initialized 2025 clients, array results such as exact `acc_inbox` reads are JSON in text content,
with `structuredContent` omitted because those revisions require an object there.
Object results retain both representations. The 2026 interface also returns raw arrays
in `structuredContent` and uses the `resultType: "complete"` envelope.

Resources are `acc://snapshot`, `acc://roster`, and `acc://inbox`. Reading `acc://inbox`
resolves the configured MCP participant and returns the same read-only summary page as
`acc_inbox {}`. Continue via the tool using `cursor`; retrieve a body with `messageId`.
Snapshot and roster reads do not advance receipts either. `acc://snapshot` and sync with
`scope: "full"` remain unbounded, for explicit workspace forensics.

`acc_sync {scope: "history", kind: "handoff"}` returns
`{scope: "history", view: "summary", items, nextCursor}` using the same message summary
fields and page limits. The optional kind filter applies before paging. Continue with
the complete `nextCursor` message id and the same filter. Then use
`acc_sync {scope: "history", messageId: "message_x"}` to receive one complete historical
message in `items`, with `view: "message"` and no receipt change. Exact reads reject
cursor, limit, and kind. `kind` and `messageId` require history scope; delta/full retain
16-digit event cursors. History exposes recorded peer claims, not their current validity.

An addressed handoff requires a participant already known to the workspace. For a future
session that has not joined, omit `toParticipantId` to leave a workspace handoff. A later
session can recover that historical handoff through the history list and exact read;
its addressed inbox will not contain past workspace broadcasts.

## Account for the manual boundary

The generic MCP capability declaration is all false:

| Group | Effective behavior |
|---|---|
| lifecycle | no automatic session-start, resume, or end signal |
| context | no startup, before-turn, or safe-point injection |
| guards | no before-read, before-write, or before-shell interception |
| delivery | no `nextTurn`, `livePush`, or native `replyRoute` |

An MCP participant therefore reports `advisory` enforcement and `manual` lifecycle.
`manual` describes ACC presence reporting, not ownership of the external client. Because
workspace protection is the weakest live participant's real guarantee, one MCP session
makes guarded claims advisory for the room.

## Decision changes

`acc_message` with `kind: "decision"` accepts either `supersedes: ["message_x"]`
or `withdraws: ["message_x"]`: 1..16 unique existing decision IDs. Supply `to: []`
to inherit target authors and recipients, including offline participants, or add
recipients explicitly. Body states the new position or reason for withdrawal.
Any owned peer may record a change; competing branches are visible, not resolved by time.

`acc_sync {scope: "history", kind: "decision", current: true}` lists terminal
positions and withdrawals with bounded `decisionStatus` metadata. Exact history
reads include the same status and preserve receipts. `current` cannot accompany
an exact ID or other scopes/kinds. Replaced decisions leave ordinary inbox/attention;
they remain available by exact ID without an automatic acknowledgement.
See [decision lifecycle](PROTOCOL.md#decision-lifecycle).

## Poll without overstating delivery

Every outgoing message commits first. `acc_message`, `acc_request`, `acc_reply`, and
`acc_finish` cannot promise push; delivery results remain queued with a durable diagnostic.
The recipient calls `acc_inbox` with `messageId` to retrieve the body. Being returned by a tool is
`retrieved`, not proof that a model attended to or obeyed it. A reply or explicit ack is
`acknowledged`.

MCP is therefore a complete communication participant with higher latency, not a fake
native adapter. Use it when a client can call tools but exposes no measured hook boundary.

Next: [Protocol](PROTOCOL.md) · [Capabilities](CAPABILITIES.md) ·
[Security model](SECURITY_MODEL.md)
