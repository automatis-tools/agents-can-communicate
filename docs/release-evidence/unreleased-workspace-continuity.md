# Unreleased native workspace continuity

The native conversation keeps the ACC room selected by its first SessionStart, or
the first user-turn hook if startup was missed. Hooks resolve that binding before
looking for the workspace-local owner. Their current cwd still resolves file targets.

## Exact local artifact

- Source: clean commit `40d207505f31f6a8d740a22a5c743ef2c9f94724`.
- Archive: `dist/workspace-affinity/agents-can-communicate-0.5.9.tgz`.
- Size: 401,444 bytes; 281 packed entries.
- SHA-256: `013e2005932b37c51c5bcc43d71e03286254ed9c100ac66cd85909be9f10f4b0`.
- Package version remains `0.5.9`; this is an unpublished development artifact.

The exact saved archive passed `scripts/verify-package.mjs`: clean installation,
doctor, no-Git workspace operations, bundled workspace versions, certification
allowlist, packed Markdown links, and install/uninstall byte restoration. No local
client installation or project history was changed. Syntax checks passed in 555 files.

## Regression and mutation evidence

The first six focused regressions failed against the old runner: parent-room peers
and inbox disappeared after moving into a nested repository, a child-launched session
moved to its parent, claims could be bypassed, and later workspace selection changed
the native owner. They passed after the routing change.

Restoring the previous runner made all ten focused hook regressions and the new
installed-package scenario fail, while the three earlier owner-header tests still
passed. Restoring the fix recovered the suite. Independent red/green tests caught
Git disappearing, Git returning after an initially unavailable probe, and a data-home
symlink putting native routing records inside the project.

The installed-package scenario starts Claude and Codex hooks in a plain parent
directory containing two Git repositories. Claude moves through both repositories
and an external linked worktree; Codex also moves into a child repository. The
original roster, owner, and inbox remain reachable. A synthetic compact SessionStart
retains the owner pair, and SessionEnd from a child closes the original session.
Focused checks also cover a Git parent, relative guarded writes, another worktree
of the original repository, missed startup, and native conversation resume.

The baseline skill reading could not determine what changed hook cwd meant for
the launch room. Reading the updated reference correctly retained both existing
sessions in the parent room and selected a separate room for a new child launch.

The initial unrestricted full run completed 2,286 tests: 2,284 passed, one skipped,
and only the expected stale-candidate-record gate failed. This record replaces that
stale candidate reference before the final gate run. A sandboxed attempt was stopped
after local Unix socket tests failed with `EPERM`; the full gate needs socket and
process-inspection access.

## Limits

These cwd and compaction checks execute installed hooks with fixture payloads, not
a new native-client delivery capture. They certify no new adapter capability.
The previous real Claude startup capture retains its original provenance.

Standalone CLI discovery remains based on its arguments/environment; owned commands
use the complete trusted header, including cwd. Separate new native conversations
launched directly in child repositories retain separate initial rooms. Existing
legacy sessions without a saved launch binding establish one on the next startup
or user-turn hook; ACC does not infer an unrecorded original launch directory.

Explicit changes to the startup workspace identity fail open with a diagnostic;
they do not merge workspaces. Historical expired channels are not renewed, and
messages are not migrated between participant identities.
