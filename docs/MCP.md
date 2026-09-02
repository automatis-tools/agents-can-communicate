# MCP

`acc-mcp` lets a client with no native ACC adapter participate over stdio. It exposes the
same durable messages, threads, receipts, intent, claims, and handoffs, but it cannot infer
the client's lifecycle, intercept writes, inject a normal turn, or push a message. The
client polls tools under its own control.

```mermaid
graph LR
  C["independently opened MCP client"] -->|"stdio JSON-RPC"| M["acc-mcp"]
  M --> S[("ACC durable store")]
```

## Register

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

The server implements MCP protocol revision `2026-07-28` over newline-delimited JSON-RPC
stdio. Tool input schemas are closed: unknown fields and invalid conditional shapes are
rejected before a session is resolved.

## Tools

| Tool | Required input | Optional input |
|---|---|---|
| `acc_status` | — | — |
| `acc_sync` | — | `cursor`, `scope: delta|full`, `limit: 1..500` |
| `acc_work` | `summary` and `mode`, or `clear: true` | `state`, `resourceHints` |
| `acc_claim` | `action`; `resource` for acquire, `claimId` for renew | `mode`, `reason`, `leaseSeconds` where valid |
| `acc_release` | `claimId` | — |
| `acc_message` | `to`, `subject`, `body` | `kind`, `obligation`, `clientMessageId` |
| `acc_request` | `toParticipantId`, `title` | `detail`, `clientMessageId` |
| `acc_inbox` | — | `messageId` |
| `acc_reply` | `messageId`, `body` | `subject`, `clientMessageId` |
| `acc_ack` | `messageId` | — |
| `acc_finish` | `goal` | `status`, `completed`, `remaining`, `blockers`, `toParticipantId`, `clientMessageId` |

All tool names above are the complete model-facing surface. There are no execution or
client-control tools.

Send-like tools return a raw structured object with `{ message, delivery }`; their text
content is the JSON serialization of the same value. `acc_inbox` returns message/receipt
pairs and advances only this participant's receipts to `retrieved`. `acc_reply` writes an
`answer` and acknowledges the original atomically. `acc_ack` exposes no receipt-state
parameter.

Resources are `acc://snapshot`, `acc://roster`, and `acc://inbox`. Reading `acc://inbox`
resolves the configured MCP participant and advances only the returned receipts to
`retrieved`, just like the inbox tool. Snapshot and roster reads do not advance receipts.
A full snapshot is for explicit workspace forensics.

## Capability floor

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

## Durable polling semantics

Every outgoing message commits first. `acc_message`, `acc_request`, `acc_reply`, and
`acc_finish` cannot promise push; delivery results remain queued with a durable diagnostic.
The recipient calls `acc_inbox` to retrieve the body. Being returned by a tool is
`retrieved`, not proof that a model attended to or obeyed it. A reply or explicit ack is
`acknowledged`.

MCP is therefore a complete communication participant with higher latency, not a fake
native adapter. Use it when a client can call tools but exposes no measured hook boundary.

Next: [Protocol](PROTOCOL.md) · [Capabilities](CAPABILITIES.md) ·
[Security model](SECURITY_MODEL.md)
