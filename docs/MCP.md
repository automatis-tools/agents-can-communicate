# MCP

For clients with no native ACC adapter. This is the participation tier: the client can
share durable coordination state, but nothing intercepts its lifecycle or writes. That
limit is useful because it extends the workspace without pretending a generic tool
surface can provide native control.

```mermaid
graph LR
  C[MCP client] -->|stdio JSON-RPC| S[acc-mcp]
  S --> W[(workspace state)]
```

## Register

```json
{ "command": "acc-mcp", "env": {
  "ACC_MCP_PARTICIPANT": "research",
  "ACC_MCP_WORKSPACE": "/path/to/the/project"
} }
```

The session comes from **this configuration**, never from `initialize` or `clientInfo`.
Restarting the process resolves to the same session.

`ACC_MCP_WORKSPACE` is the project this server joins. Without it the server takes the
directory the client launched it in, which is rarely the project and is silent about it —
`acc_sync` answers `solo` from a workspace nobody else is in. There is nothing to pass on
the command line: `acc-mcp` takes no arguments and says so rather than ignoring them.

## Tools

| Tool | Does |
|---|---|
| `acc_sync` | New events, roster, attention |
| `acc_work` | Publish intent |
| `acc_claim` | Reserve a resource |
| `acc_message` | Send a message |
| `acc_inbox` | Read unresolved messages addressed to this participant, optionally one id |
| `acc_reply` | Reply to one message and acknowledge the original atomically |
| `acc_ack` | Acknowledge without a written reply |
| `acc_request` | Ask another agent to do something |
| `acc_task` | Create work, take it, or move it along |
| `acc_workstream` | Group related work. Optional |
| `acc_decide` | Record a durable decision |
| `acc_finish` | Handoff and release |

Use `acc_inbox`, not `acc_sync --scope full`, to recover an addressed message. Resources:
`acc://snapshot`, `acc://roster`, `acc://workstreams`, `acc://tasks`, `acc://inbox`.

## When this tier fits

Use MCP when shared presence, requests, claims, and handoffs matter more than automatic
delivery or guarded writes. Move to a native adapter when the client exposes hooks that
can prove those stronger capabilities. The stored coordination model stays the same; only
the integration's reach changes.

## What you do not get

```mermaid
graph TB
  Y[Yes] --> Y1[attach on first call]
  Y --> Y2[read everything]
  Y --> Y3[claim, message, hand off]
  N[No] --> N1[writes are not guarded]
  N --> N2[no session end]
  N --> N3[no push delivery]
```

The roster says so: an MCP participant reads `advisory` / `manual`, and a workspace with
one connected reports `advisory` protection even when a claim was declared `guarded`.

Protocol revision `2026-07-28`. Details in `packages/mcp-server/COMPATIBILITY.md`.
