# A peer that a live push reached is not unavailable: development evidence

This records the development candidate for #211. It is not a published release.

## What the investigation found

`recipient_unavailable` reported each recipient of a sender's reply- or acknowledgement-bound
message that had no online session. Online means a heartbeat within three cadences. A session
waiting for its person sends no heartbeat, so it is stale. A live push into it records the
receipt as `offered`, with the live transport, before the woken turn's first hook sends a
heartbeat. Until that hook ran, the sender's attention (its next turn, `acc status`, `acc sync`)
said the recipient was unavailable. The skill then told it to contact the recipient or wait.

The window is short when the push starts a turn at once. That is why the live check with ACC
0.8.1 on 2026-09-27 did not show it: the woken peers took a turn within seconds. The window
lasts as long as a person takes when the client asks for approval before the woken turn runs.

## Change

A recipient whose receipt a live transport offered, to a session that is not offline, is
reachable. These cases still report it as unavailable:
- a queued message;
- an offer through the next turn, because an earlier turn showed it and the session has idled
  since;
- an offer that an older ACC recorded without the transport;
- a session that has ended since the push.

## Exact artifact

- Source: clean commit `fe41340e1640ecac9d728ca6573339fa00311237`.
- Archive: `agents-can-communicate-0.15.3.tgz`, 663,087 bytes, 392 files.
- SHA-256: `1910e4b50b6176ff543330e39e8f9818d4dc4ec6f5c7159e8f3cfa8cb6f41b29`.
- Node 24.4.0, npm 11.4.2, macOS arm64.

The exact archive passed `scripts/verify-package.mjs`. Its packed `@agents-can-communicate/core`
computed the sender's attention for a recipient whose only session was idle for ten minutes:

| Receipt | Attention |
|---|---|
| offered by `local-daemon` | none |
| offered by `local-daemon`, session since closed | `recipient_unavailable` |
| queued | `recipient_unavailable` |
| offered by `next-turn` | `recipient_unavailable` |

## Limits

- No real client was observed inside the window. A live push that waits for approval was not
  captured, so the approval case rests on the receipt and presence rules.
