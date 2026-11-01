# Unreleased: contributing guidance

| Development artifact | Value |
|---|---|
| Built from | `c4ee4c159c25db8a8aaf927aa8ea9352f7f7a07a` |
| Tarball | `agents-can-communicate-0.12.2.tgz`, 631,384 bytes, 381 files |
| sha256 | `b26b3f0de88c7b1ba98536ba39746619cb040d137d65a832d161c85443f48399` |

The source worktree was clean immediately before packing. The exact archive passed
`node scripts/verify-package.mjs <exact-tarball>` on macOS arm64 with Node 24.4.0.
The supplied-archive verifier reports its source revision as unknown. The table
records the clean source commit captured before packing.

The packed change is documentation only (#175). The README links `CONTRIBUTING.md`
instead of `AGENTS.md` and no longer calls the project noncommercial. The docs index
links both pages. `CONTRIBUTING.md`, the pull request template and the issue chooser
are repository files that npm does not pack.

Verification covers the exact package inventory and boundaries, installed CLI,
packed documentation links, doctor, a workspace without Git, and reversible
client integration. It does not establish native model execution. No package
publication or production deployment was performed.
