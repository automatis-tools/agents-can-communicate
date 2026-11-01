# Unreleased: process start times across the repeated DST hour

| Development artifact | Value |
|---|---|
| Built from | `cdb84f4df5563589b0ae03dbe64805e7dfe36c4f` |
| Tarball | `agents-can-communicate-0.12.2.tgz`, 630,664 bytes, 381 files |
| sha256 | `fc0e0dc6b27f78a610e54d6f2d28edc96a46b2563f06c580fb5e9198eeabbfc4` |

The source worktree was clean immediately before packing. The exact archive passed
`node scripts/verify-package.mjs <exact-tarball>` on macOS arm64 with Node 24.4.0.
The supplied-archive verifier reports its source revision as unknown. The table
records the clean source commit captured before packing.

The managed runtime now runs `ps -o lstart` with `TZ=UTC0` and reads the result as
UTC, for the reused-pid check and for legacy update-helper retirement (#402).
Codex and Antigravity compare start-time strings only with each other and are unchanged.

On 2026-11-01 between 01:00 and 02:00 EST, both affected checks failed on main and passed
with this change on macOS. Regression tests also fail with the previous parsing outside
that hour.

Verification covers the exact package inventory and boundaries, installed CLI,
packed documentation links, doctor, a workspace without Git, and reversible
client integration. It does not establish native model execution. No package
publication or production deployment was performed.
