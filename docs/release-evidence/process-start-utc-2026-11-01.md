# Unreleased: process start times across the repeated DST hour

| Development artifact | Value |
|---|---|
| Built from | `0f1ef42a5eca437702c53e13cf97cd5e072c2336` |
| Tarball | `agents-can-communicate-0.12.2.tgz`, 630,786 bytes, 381 files |
| sha256 | `e3c01c49d72f25d779ababf7fd51af308f7e0949e1adce1afaa19871ef61ab47` |

The source worktree was clean immediately before packing. The exact archive passed
`node scripts/verify-package.mjs <exact-tarball>` on macOS arm64 with Node 24.4.0.
The supplied-archive verifier reports its source revision as unknown. The table
records the clean source commit captured before packing.

The managed runtime now runs `ps -o lstart` with `TZ=UTC0` and `LC_TIME=C` and reads
the result as UTC, for the reused-pid check and for legacy update-helper retirement (#402).
An existing `LC_ALL` moves to `LC_CTYPE`, so a non-ASCII command line keeps its text.
Codex and Antigravity compare start-time strings only with each other and are unchanged.

On 2026-11-01 between 01:00 and 02:00 EST, both affected checks failed on main and passed
with this change on macOS. Tests with a mocked `ps` reproduce the repeated hour and fail
with the previous parsing at any time of day. Checks against the real `ps` in three zones
are positive controls.

Verification covers the exact package inventory and boundaries, installed CLI,
packed documentation links, doctor, a workspace without Git, and reversible
client integration. It does not establish native model execution. No package
publication or production deployment was performed.
