# Development artifact: Awesome Claude Code badge

Captured on October 25, 2026 with Node 26.5.1 on macOS. This is an unpublished
development artifact, built from `c2dddad5a5c9d487d0f7a2f5fa02ad8732e49121`.
The package version remains `0.11.1`; existing release records are unchanged.

| Artifact | Value |
|---|---|
| Filename | `agents-can-communicate-0.11.1.tgz` |
| Packed size | 611,323 bytes |
| Files | 376 |
| sha256 | `e222d53d3bd81b012918c05e37ec6546b4e17e05bb24bc2e1dda9e8ccd4bc208` |

`npm pack --json` created the archive. `node scripts/verify-package.mjs` verified
that exact archive and reported PASS, including installed entry points, runtime
enrollment, and install/uninstall restoration. No package was published.

The build is `main` after #319 plus one badge line in `README.md`, which npm includes
in every archive. The documentation tests passed with it.
