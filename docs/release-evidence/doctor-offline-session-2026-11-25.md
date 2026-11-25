# Doctor reports a session whose client exited as offline: development evidence

This records the fix for #453 and its development candidate. It is not a published release.

## Cause

A client that exits without a session end leaves its ACC session open, and the session's
delivery binding with it. Presence calls that session offline once its process is gone or no
heartbeat came for a day. The router then offers it nothing, and its messages wait until it
returns.

Doctor read every open session's binding. It asked the adapter to re-verify the receiver of an
offline session, the receiver did not answer, and doctor printed "degraded; no live delivery:
the session handshake failed; check the client's integration/channel setup". The same line
ended with the session's last bind attempt, "local handshake succeeded". `acc status --json`
also listed the binding, so doctor's adapter line read "channel unreachable", also when status
hid the offline session.

Status now lists delivery bindings only for sessions that are not offline. The session row of
an offline participant with waiting messages still shows `liveDelivery` and `waiting`. Doctor
names an offline session `offline` and does not ask its receiver.

## Observation

On 2026-11-25, ACC 0.15.5 on macOS: a Codex 0.167.0 session from 2026-11-10 had exited without
a session end, and one request to it was queued. `acc status` listed it `offline` with
`waiting: 1`. Doctor printed the failed-handshake line above and "channel unreachable" for
Codex CLI.

The changed doctor code, run read-only against the same state, printed:

- `Codex CLI live delivery: ...; enabled (actionable); no live channel bound in this workspace`
- `Codex CLI session codex-…: offline: its client is no longer running, so ACC attempts no live
  push; messages wait until the session returns; last attempt 2026-11-10T16:26:04.798Z: local
  handshake succeeded`

## Development candidate

- Source: clean commit `b3836f714b4b36562a34094fedd103094a73fdbe`.
- `agents-can-communicate-0.15.5.tgz`, 675,812 bytes, 398 files.
- SHA-256: `b87795e667e05b43ae87f57532784624ac627dd7be4fc239e7aabf66e356f74e`.
- The exact archive passed `scripts/verify-package.mjs`.

## Tests

- `packages/core/test/delivery-bindings.test.mjs`: a stale session's binding is still listed;
  an offline session's binding is not, and its record stays. It failed before the change.
- `packages/cli/test/native-session-deliverability.test.mjs`: an offline session is not
  re-verified, reads `offline` with the wait explanation, and has no failed-handshake text. It
  failed before the change.

Each assertion was also checked by mutation: removing the status filter, or the doctor's
offline check, makes its test fail.
