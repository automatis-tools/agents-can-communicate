# MCP compatibility

Verified 2026-08-16 against the primary specification at
<https://modelcontextprotocol.io/specification/>.

| Item | Value |
|---|---|
| Protocol revision | **2026-07-28** |
| Transport | stdio, newline-delimited JSON-RPC 2.0 |
| Transport implementation | dependency-free (see decision below) |

## Transport decision

Dependency-free JSON-RPC 2.0 over stdio, targeting revision `2026-07-28`. The official
`@modelcontextprotocol/sdk` was considered and not adopted.

Reasons, in order of weight:

1. AGENTS.md prefers Node built-ins and dependency-free code, and the repository currently
   has zero runtime dependencies. This package is reached through `npx`, so every
   dependency is install weight and supply-chain surface for a fallback adapter.
2. The surface ACC needs is small and fully specified: `server/discover`, `tools/list`,
   `tools/call`, `resources/list`, `resources/read`, plus newline-delimited framing. The
   stdio binding is, in the specification's own words, "just newline-delimited JSON-RPC
   over a byte stream".
3. The cost is ours to carry: tracking future revisions is now this package's job. The
   revision is pinned in code and asserted by tests, so a drift shows up as a failure
   rather than as silent misbehaviour.

## Verified rules

- Messages are newline-delimited and **MUST NOT** contain embedded newlines.
- The server **MUST NOT** write anything to stdout that is not a valid MCP message.
  stderr is free for logging and the client **SHOULD NOT** treat it as an error signal.
- The server **MUST NOT** write JSON-RPC *requests*. Server-to-client interaction is
  carried in `InputRequiredResult` replies.
- The server **SHOULD** exit promptly on stdin EOF. That is the only portable graceful
  shutdown signal.
- Every request carries `_meta["io.modelcontextprotocol/protocolVersion"]` (required) and
  `_meta["io.modelcontextprotocol/clientCapabilities"]` (required);
  `io.modelcontextprotocol/clientInfo` is optional. A request missing a required field
  **MUST** be rejected with `-32602`.
- Results **SHOULD** carry `_meta["io.modelcontextprotocol/serverInfo"]` and **MUST**
  include a `resultType`.
- Reserved error codes: `-32020` HeaderMismatch, `-32021` MissingRequiredClientCapability,
  `-32022` UnsupportedProtocolVersion. `-32000`–`-32019` are legacy and must not be used;
  `-32002` and `-32042` must not be emitted.

## Why the session is not tied to `initialize`

The obvious design — open one ACC session during the MCP `initialize` handshake and close it
on stdin EOF — is invalid at revision 2026-07-28 on three counts:

1. `initialize` is the **legacy** era. Modern clients probe with `server/discover` and
   receive a `DiscoverResult` listing `supportedVersions`.
2. The protocol is explicitly stateless: *"Servers **MUST NOT** rely on prior requests over
   the same connection to establish context (e.g. capabilities, protocol version, client
   identity)"*, and *"an open connection, such as a STDIO process, is not a conversation or
   session … a server must not treat connection or process identity as a proxy for
   conversation or session continuity"*. Clients may restart the server freely, which under
   the planned design would open a second ACC session and orphan the first.
3. `clientInfo` is self-reported and the specification says implementations **SHOULD NOT**
   rely on it for behaviour or security decisions, so it cannot supply participant
   identity.

## Approved session model

Config-derived session (user decision, 2026-08-16). The ACC session is derived from the
server's own launch configuration — participant name and workspace root supplied when the
MCP server is registered — never from prior requests, connection identity, or
`clientInfo`. Presence is refreshed on each tool call. A restarted server process resolves
to the same session rather than creating a second one.

This does not violate statelessness: the server infers nothing from earlier requests. Its
identity comes from its own configuration, which is available on every request
independently.

Capabilities remain truthful: manual MCP tool polling is not `delivery.nextTurn`,
`delivery.livePush`, or `delivery.replyRoute`; lifecycle, guards, and all three delivery
modes stay false because MCP guarantees none of them.
