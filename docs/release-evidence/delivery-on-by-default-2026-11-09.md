# Live delivery on by default: development evidence

This records the development candidate for turning live delivery on by default. It is not a
published release.

## Exact artifact

- Source: clean commit `f826841a51b69ccb5ff112f1d198ee53747a3bb8`.
- Archive: `agents-can-communicate-0.14.1.tgz`, 655,842 bytes, 390 files.
- SHA-256: `d358d13b849378391645ecde4df9c14cc534b1bf3e07905d8dd8ffbb23c949c3`.
- Node 24.4.0, npm 11.4.2, macOS arm64.

The exact archive passed `scripts/verify-package.mjs`.

## Behaviour covered by tests

- With no `--delivery`, a client that can receive live delivery gets `actionable` and a
  `default-enabled` decision. No run asks a question.
- An off from `--delivery off` or from the old interactive "No" stays. An off that ACC recorded,
  or an off with no coherent record of a choice, turns on once the client can receive delivery.
- A managed update applies the same rule. When that turns Kimi on, the Codex profile written in
  the same refresh carries the `127.0.0.1` rule.
- A service the default cannot start is reported and does not fail the install. A service
  requested with an explicit `--delivery` still fails it.

## Limits

- Real clients have not yet run this candidate.
