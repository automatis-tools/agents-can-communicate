# Unreleased fallback diagnostics tell the truth about certification

Found immediately after updating the maintainer's machine to the published 0.6.2. Delivery
worked - a peer message arrived in a Claude Code 2.1.278 session with its body intact, where an
hour earlier it had been withheld - but `acc doctor` still printed this beside Gemini CLI
0.60.0:

```
Gemini CLI next-turn delivery is certified only for 0.57.0 on darwin-arm64; other or
unknown versions keep durable acc inbox access, and live push is unavailable
```

The sentence is an adapter's static `deliveryFallback.diagnostic`, which doctor prints
verbatim. 0.6.2 removed the gate it described, and the downgrade prefix doctor used to add in
front of it is gone, so what remains reads as a statement that the installed client is
unsupported when it is not.

## Exact local artifact

- Source: clean commit `96f78ad33b1c94c771e6855aea12d6f51dd7e82e`.
- Archive: `agents-can-communicate-0.6.2.tgz`, packed from that commit.
- Size: 446,522 bytes; 306 packed entries.
- SHA-256: `878a4efeec5ca3015f4252a0a59ba1b7f7ec11c65d8d7dfb15a2fa0d86372d02`.
- Package version remains `0.6.2`; this is an unpublished development artifact.

The exact archive passed `scripts/verify-package.mjs`: pack, contents, certification
allowlist, packed Markdown links, bundled workspace versions, clean installation, doctor,
no-Git workspace operations, and install/uninstall byte restoration.

## What each client was told, and what it is told now

| Adapter | Before | Now |
|---|---|---|
| Gemini CLI | certified **only for 0.57.0** on darwin-arm64 | certified **from 0.57.0 onward**, on every platform |
| Kimi Code | certified **only for 0.36.1** on darwin-arm64 | certified **from 0.36.1 onward**, on every platform |
| Antigravity CLI | certified for 1.2.7 and **later stable releases on darwin-arm64** | certified **from 1.2.7 onward** |

Two diagnostics were left alone because they were already accurate. Codex CLI's names the
native contract minimum - `codex-cli 0.152.1 or newer on darwin-arm64` - which is
`nativeDelivery.minimumByPlatform` rather than capture evidence, and stays per-platform.
Claude Code's names client-side Channels activation and claims no version at all.

The Kimi and Antigravity `COMPATIBILITY.md` delivery sections carried the same stale claim and
now read the same way as the diagnostics.

## Regression guard

`tests/conformance/adapter-contract.mjs` holds every adapter to it: a `deliveryFallback`
diagnostic may not say "certified only for", nor tie the word certified to a single platform
before the next clause. Both patterns were checked against the three superseded sentences and
against every current one, including the two deliberately left in place.

## Limits

This changes text that `acc doctor` and `acc install` print. No capability, capture, receipt or
delivery path changes, and no new client behaviour is claimed.
