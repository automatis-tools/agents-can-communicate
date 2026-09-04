# Cross-vendor communication acceptance

This is the v0.3 release contract for two independently opened sessions. It tests
communication semantics, not whether ACC can create or control either client.

## Activation event

A second independently opened session completes a useful acknowledged interaction without
the human copying peer message content.

The required flow runs in both directions:

```text
Claude asks Codex a project question
-> Codex retrieves the exact message without human relay
-> Codex answers in the same ACC thread
-> Claude retrieves the answer
-> Codex's receipt for the question is acknowledged
```

Then Codex asks Claude and the same assertions hold. The question root has
`threadId === messageId`; the answer preserves that thread and names the question in
`inReplyTo`. Recipient receipts belong to that participant alone.

## Delivery route used by this release

The real-client feasibility captures deliberately did not manufacture native reachability:

| Client capture | Native result | Shipped fallback |
|---|---|---|
| Codex CLI 0.152.0 on `darwin-arm64` | fail — existing app-server control socket absent; no daemon or target process started | exact-certified Codex 0.147.0 next-turn delivery, otherwise `acc inbox` |
| Claude Code 2.1.252 on `darwin-arm64` | fail — development-channel warning stopped the run before the ACC MCP child started | exact-certified Claude Code 2.1.233 next-turn delivery, otherwise `acc inbox` |

Therefore the release acceptance completes the semantic flow through certified next-turn
or explicit inbox fallback. It must not report `livePush`, native reply routing, or model
attention. A queued message remains a valid durable message; retrieval and acknowledgement
are separate observations.

## Packed-artifact proof

The automated release test installs the generated tarball into a clean temporary prefix
and invokes only the packed bins and bundled packages. For each direction it must prove:

1. the question commits before any delivery attempt;
2. the recipient retrieves the same `messageId` without the human copying its body;
3. reply creates one `answer` in the original thread;
4. the reply atomically acknowledges only the recipient's question receipt;
5. the original sender retrieves the answer;
6. an explicit `clientMessageId` retry returns the same logical question or answer;
7. restarting a session generation cannot reuse a stale delivery binding;
8. an unknown client version visibly falls back while inbox communication still completes;
9. uninstall is idempotent and preserves every foreign client setting.

The human-relay sentinel starts false and must remain false for the entire flow. Test code
may carry ids between commands; it may not copy a peer message body into another session's
input.

## Capability assertions

The same acceptance run records four independent dimensions:

| Dimension | Required assertion |
|---|---|
| certified support | only exact passing evidence resolves true |
| current reachability | no stale or ambiguous generation is chosen |
| recipient policy | default `off`; unsupported opt-in remains effectively off |
| fallback | next-turn or inbox completes with a queued/retrieved/acknowledged trail |

An `offered` receipt would require captured bytes crossing a certified transport boundary.
This release's Codex and Claude fallback scenario should not manufacture one.

## Supporting evidence

- `packages/adapter-codex/fixtures/delivery/codex-cli-0.152.0.json`
- `packages/adapter-claude-code/fixtures/delivery/claude-code-2.1.252.json`
- each adapter's `certification.json` and `COMPATIBILITY.md`
- packed acceptance tests under `tests/acceptance/`

The release gate is successful only when the installed artifact, not the source checkout,
completes both directions and reports the downgrade truthfully.
