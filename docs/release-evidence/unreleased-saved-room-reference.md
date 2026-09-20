# Unreleased saved room reference

This follows the native launch-room binding in
[workspace continuity evidence](unreleased-workspace-continuity.md). Each native
owner header now includes a stable `--workspace acc://<reference>` argument, so a
CLI command selects the saved room even if discovery changes after the hook runs.
The reference names one validated record in ACC's data home; it supplies no owner
credentials and performs no network access.

## Exact local artifact

- Source: clean commit `686c3303f4e60de6c561a7d44647617ae8778c19`.
- Archive: `dist/workspace-reference/agents-can-communicate-0.5.9.tgz`.
- Size: 402,272 bytes; 281 packed entries.
- SHA-256: `f54b899e0d074be2e2d722096a643ee5ede8fa40514d547dd0b4d3533382195e`.
- Package version remains `0.5.9`; this is an unpublished development artifact.

The exact saved archive passed `scripts/verify-package.mjs`: clean installation,
doctor, no-Git workspace operations, bundled versions, certification allowlist,
packed Markdown links, and install/uninstall byte restoration. Syntax checks
passed in 555 files. The 29 focused room, owner-continuity, and context-budget
checks passed with no skips. The recorded-candidate gate passed all three checks.

The final unrestricted `npm test` run completed 2,288 tests: 2,287 passed, zero
failed, and one skipped in 506 seconds. The skip is the existing absent-Gemini
uninstall case because Gemini is installed on this machine. Local Unix socket
and process-inspection access was enabled for this full run. No source changed
while the gate ran.

## Regression and mutation evidence

The installed-package regression captures the trusted owner header before
`git init`, then uses that same header for status and inbox afterward. It failed
with a cwd-only header and with a reference emitted only after discovery changed.
It passes when every saved native room supplies its reference from startup.
Removing the session credentials still rejects inbox access.

Real filesystem checks reject malformed or missing references, symlinked records,
and records whose adapter/native identity does not match the reference hash.
Removing that hash comparison made the identity test fail; restoring it passed.

Context-budget cases measure the complete header and exercise the remaining space
for message recovery. Removing owner-byte reservation made both tight-budget and
ambient-budget tests fail. Allowing the owner line to consume pending-message
recovery space made the recovery test fail. Restoring both checks passed.

The baseline skill reading dropped an unmentioned workspace argument. Reading the
updated skill retained session, generation, cwd, and workspace in the resulting CLI
command, and correctly distinguished a room reference from ownership credentials.

## Limits

This artifact includes the earlier launch-room binding and compaction fixes. The
new checks execute installed hooks with fixture payloads; they do not certify new
native delivery capabilities. Existing real-client captures retain their original
source and archive provenance. No installed client or live project state changed.

New native conversations started directly in child repositories still choose their
own initial rooms. A legacy conversation without a saved launch binding establishes
one on its next startup or user-turn hook; its original cwd cannot be reconstructed.
Standalone CLI calls must use the complete trusted owner header to select a native
room. Historical messages and expired channel leases are not migrated or renewed.
