# Unreleased: website changelog step in the release procedure

| Development artifact | Value |
|---|---|
| Built from | `ab8a25a715abc99ddbd0e5838237ca0bcbddd963` |
| Tarball | `agents-can-communicate-0.14.0.tgz`, 654,965 bytes, 390 files |
| sha256 | `f5a54bc2e43761b230b3c517215b66afcf6663085b7c6fd6e1750185104cc097` |

The source worktree was clean immediately before packing. The exact archive passed
`node scripts/verify-package.mjs <exact-tarball>` on macOS arm64 with Node 24.4.0.
The supplied-archive verifier reports its source revision as unknown. The table
records the clean source commit captured before packing.

The packed change is documentation only. `docs/RELEASING.md` gains a final step that
adds each release to the changelog at getacc.dev.

Verification covers the exact package inventory and boundaries, installed CLI,
packed documentation links, doctor, a workspace without Git, and reversible
client integration. No package publication or production deployment was performed.
