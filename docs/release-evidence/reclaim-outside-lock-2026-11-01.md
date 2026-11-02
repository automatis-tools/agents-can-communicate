# Unreleased: commands right after an update

| Development artifact | Value |
|---|---|
| Built from | `3f921d2f11ae8f04da152136d4df9e90f132f56f` |
| Tarball | `agents-can-communicate-0.12.2.tgz`, 631,235 bytes, 381 files |
| sha256 | `df561d10785a1b8d403baa237d61f2d92215a782986d93d1611fcbf7adfe41a9` |

The source worktree was clean immediately before packing. The exact archive passed
`node scripts/verify-package.mjs <exact-tarball>` on macOS arm64 with Node 24.4.0.
The supplied-archive verifier reports its source revision as unknown. The table
records the clean source commit captured before packing.

Reclaim now proves a generation unreferenced and moves it into `reclaimed/` under the
manager lock, then deletes the tree after the lock is released (#406). A generation whose rename
stays busy for 250 ms, as an open handle on Windows makes it, is kept for a later pass. Admission waits
one second for that lock. Before this change, deleting a generation on a loaded Mac
held the lock longer, and `acc uninstall` right after a background update returned
"runtime unavailable; retry after the update".

A 3 s delay in deletion reproduces that refusal in the managed-update acceptance test
and in a focused admission test ("manager lock held; acquisition timeout"). With this
change both pass with the same delay.

Verification covers the exact package inventory and boundaries, installed CLI,
packed documentation links, doctor, a workspace without Git, and reversible
client integration. It does not establish native model execution. No package
publication or production deployment was performed.
