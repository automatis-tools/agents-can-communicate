# MCP compatibility

Verified 2026-09-06 against the primary specifications and real installed clients.

| Interface | Supported revisions | Opening exchange |
|---|---|---|
| Initialized stdio | `2025-06-18`, `2025-11-25` | `initialize`, then `notifications/initialized` |
| Per-request stdio | `2026-07-28` | request metadata; `server/discover` for discovery |

## Observed client behavior

The installed ACC 0.3.1 development candidate was tested on macOS arm64 with Node 26.5.1.
Separate authenticated CLI processes launched its stdio binary; a transparent byte-forwarding
observer recorded protocol metadata, without model transcripts or tool bodies.

| Client | Observed initialization | Actual model tool calls |
|---|---|---|
| Codex CLI 0.153.4 | `2025-06-18`, `codex-mcp-client` | `acc_status` and `acc_inbox` succeeded |
| Claude Code 2.1.263 | `2025-11-25`, `claude-code` | `acc_status` and `acc_inbox` succeeded |

Both successful smoke runs began at 2026-09-06 17:58 UTC and exited normally. Codex used
invocation-local approval for the two ACC tools; Claude used an ACC tool allowlist.
The workspace and ACC data directory were temporary. No native hook installation was used.
This verifies the manual MCP surface on those versions, not native wake, injection,
write guards, client lifecycle, other operating systems, or other client versions.
The 2026 interface is covered by protocol tests; no real 2026 client was observed here.

A subsequent live pair completed a review, clarification, linked answer, code correction,
independent 7-test verification and structured handoffs through MCP. Both clients exited
normally. A fresh third session recovered the author's handoff using `acc_sync` with full
scope, without the previous conversation or project-file reads. Addressing a not-yet-known
successor was refused; the author recovered by recording a workspace handoff instead.
These were explicitly prompted workflows with polling, not spontaneous coordination or
automatic checkpointing. Final messages left after a recipient stopped remained queued.

The original server rejected both clients' initialization with `-32602` because it
required 2026 metadata. After adding initialization, Claude rejected an inbox array
in `structuredContent`. The compatibility boundary now handles both differences.
The subprocess lifecycle tests exercise both revisions, and the installed-package
acceptance test sends, retrieves and acknowledges linked replies between them. Restoring
the original server or removing the array conversion makes these regression gates fail.

## Transport contract

ACC uses dependency-free, newline-delimited JSON-RPC 2.0 over stdio. The supported
surface is `initialize`, `ping`, `server/discover`, `tools/list`, `tools/call`,
`resources/list`, and `resources/read`. Logs go to stderr; stdin EOF ends the process.
No server-initiated requests or push notifications are implemented.

For initialized clients:

- A supported requested revision is echoed; an unknown revision negotiates `2025-11-25`.
- Initialization validates `protocolVersion`, `capabilities` and `clientInfo` without
  using self-reported client identity to select an ACC participant.
- Normal requests follow `notifications/initialized`. Ping can be used during startup.
- Results have the 2025 envelope. Nonobject results remain serialized JSON text, with
  `structuredContent` omitted; object results also expose structured content.

For per-request clients:

- Every request supplies its own `_meta["io.modelcontextprotocol/protocolVersion"]`
  and object `_meta["io.modelcontextprotocol/clientCapabilities"]`.
- Missing or malformed metadata returns `-32602`; unsupported versions return `-32022`.
- Results include `resultType: "complete"` and server information in `_meta`.
- Structured content retains its original JSON type, including inbox arrays.

The two interfaces can coexist on one stream. A request containing either reserved
metadata key must supply both valid fields; a preceding initialization cannot fill them.
Initialization readiness belongs only to the 2025 transport interface.

## ACC session model

The ACC session is derived from the server's own participant and workspace launch
configuration, as approved on 2026-08-16. It is never derived from `clientInfo`,
initialization, or process identity. Presence is refreshed on tool calls. A restarted
server resolves the same durable binding; EOF does not close that ACC session.

As a receiver, generic MCP has no native binding, push/wake, or reply route:
`delivery.nextTurn`, `delivery.livePush`, and `delivery.replyRoute` remain false, as do
lifecycle, injection and guard capabilities. The installed MCP server separately records
outgoing message/request/reply/handoff operations before routing them through eligible,
opted-in recipient adapters. Inspect their delivery results; native acceptance does not
establish model attention, a separate retrieval, or a reply.

## Primary sources

- [2025-06-18 lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)
- [2025-11-25 lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
- [2025 tool results](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [2026 versioning and dual-era compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [2026 tool results](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
