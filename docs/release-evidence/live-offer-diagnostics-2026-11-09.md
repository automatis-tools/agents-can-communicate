# Unreleased: a held note explains itself, and a slow Codex refresh no longer drops an offer

| Development artifact | Value |
|---|---|
| Built from | `2c18c44a9edac39b2faed376e4423e62221c1bb2` |
| Tarball | `agents-can-communicate-0.14.0.tgz`, 655,344 bytes, 390 files |
| sha256 | `f27028308743ee0f25e1e06c69c2fa4754ec5c00e7beedd438fd052ba14c5637` |

## What was measured before the change

On the maintainer's Mac on 2026-11-09, with ACC 0.14.0, Claude Code 2.1.319, Codex 0.167.0 and
Antigravity CLI 1.5.3 in one disposable repository, at load averages of 50 to 128:

- Claude Code's first handover used `note`. The sender saw `live offer unavailable
  (delivery_disabled)` although every session had live delivery on, and no idle session woke.
- Three requests to a Codex session idle for more than 120 seconds returned
  `recipient_unavailable`, from two senders. No `message.offer_failed` event was written, and the
  requests stayed queued. Later sends to that session succeeded.
- 209 cold single-process refreshes of a Codex binding with the 750 ms bound gave 20
  `handshake_timeout` results, in bursts of two to four. The link between those timeouts and the
  three failed requests is inferred: the old code kept no record of the cause.

## What changed

- `delivery-router/router.mjs` adds `waitsForNextTurn` when the `actionable` policy holds a message.
- `cli/recorded-text.mjs` prints the next-turn explanation for that outcome.
- `delivery-router/refresh-binding.mjs` uses a 5,000 ms bound, the bound `offerMessage` has, and
  maps `handshake_timeout` to `transport_error`.
- `delivery-router/router.mjs` records a failed offer for that error.
- Each client's ACC skill states that a note does not wake an idle session.

## Verification

- Five new tests failed on the previous code and pass on this one.
- The branch CLI sent to a real idle Codex 0.167.0 session after its 120-second lease expired, at
  load about 26. The note printed the next-turn explanation. The request returned `live offered
  via codex-app-server`, and Codex answered without another prompt.
- 50 cold refreshes with the new bound all succeeded, the slowest in 226 ms, at load about 28.

The new bound was not exercised under the load that produced the timeouts, because the load had
fallen by then. A deterministic test covers a receiver that needs more than 750 ms.
