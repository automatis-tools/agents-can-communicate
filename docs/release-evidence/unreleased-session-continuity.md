# Session ownership continuity — local evidence

Captured 2026-09-19 on macOS arm64. This is an unpublished development artifact.
The published 0.5.9 evidence remains unchanged.

| Artifact | Value |
|---|---|
| Source commit | `4adbac5c38167f75b78d624db6cf7d7ef8b6c3ce` |
| Archive | `agents-can-communicate-0.5.9.tgz` |
| Bytes / entries | 398,941 / 280 |
| SHA-256 | `d18905f8ada5fb66d6f77b70b0c4015870986bbf64d2369e6f8ad9af47807105` |

The source tree was clean immediately before packing. The archive supplied to
`node scripts/verify-package.mjs` passed clean installation, bundled workspace and
certification checks, packed documentation links, doctor, a non-Git participant
and claim, and byte-for-byte client-home restoration after install/uninstall.

## Reproduction and correction

Before implementation, the installed-package regression failed on three exact
symptoms: a turn header read an empty workspace after changing shell cwd;
SessionStart with source `compact` returned no owner context; and owned status
accepted a session absent from the selected workspace. Leading-global parser
cases failed with `unknown command: --cwd`.

After implementation, these six tests passed. The shell test uses a directory
containing spaces, an apostrophe and a command-substitution literal, and verifies
that no substitution ran. The compact event preserves one session and its
participant's pending inbox, with the receipt still queued.

Review found that managed entry also needed the prefix parser. New update and
doctor recovery cases failed by choosing the old active implementation before the
fix, then passed with the shared dependency-free scanner and shipped launcher
module. The focused parser, management entry, owner and skill checks passed all
42 tests. The owner budget and installed continuity checks passed all 20 tests.
Syntax checking passed all 552 tracked JavaScript modules.

Final `npm test`: 2,273 tests discovered, 2,272 passed, zero failed, one skipped
(462.0 seconds). The skipped test requires an absent Gemini CLI; Gemini is installed
on this machine. This full run followed correction of five old gate assumptions:
empty SessionStart output after optional probe timeouts, command-first documentation
scanning, and the launcher module inventories in security and native evidence checks.
All 14 affected checks passed separately before the complete rerun.

Mutation checks rejected a remote import in the new launcher module, an invented
command after a leading global option, and removal of owner restoration after a
probe timeout. The native evidence test also corrupts the new immutable launcher
module and requires verification to fail.

A separate demonstration installed this exact archive into disposable parent and
nested Git repositories with a linked worktree. It confirmed distinct parent/nested
workspaces, shared nested-repository/worktree identity, unchanged owner arguments
after the compact event, an inbox read from the other worktree, and a reply that
acknowledged the original message. All five checks passed.

## Real-client observation

Claude Code 2.1.278 returned the exact session, generation and workspace arguments
from a real SessionStart command hook. The isolated probe had no UserPromptSubmit
hook, tools, MCP servers or session persistence. Its prompt supplied no credentials.
The model omitted the display label, so the initial whole-header string matcher
failed; the exact argument comparisons passed. Sanitized metadata and source hashes
are retained in `tests/fixtures/claude-start-owner-2.1.278.json`.

This observes startup context. Real auto-compaction was not captured; its repeated
SessionStart and inbox continuity are installed-process regressions. No new generic
startupInjection, live-delivery, or receipt capability is certified.

## Incident boundaries

Read-only local discovery found different Git common directories for the parent
repository and nested web repository. The web repository and its own worktree
resolve to the same workspace. Automatic workspace merging would change that
established contract, so discovery remains unchanged.

Two historical Claude live-delivery bindings in the parent workspace had expired
leases. Those records establish unavailable delivery routes, not why the channels
stopped. This change neither renews those old channels nor moves messages between
participants. Live configuration and project history were not changed.
