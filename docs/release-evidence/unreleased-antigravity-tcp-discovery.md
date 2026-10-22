# Development artifact: Antigravity TCP discovery

Captured on October 21, 2026 with Node 24.4.0 on macOS. This is an unpublished
development artifact, built from `03c1d2d6ef72b948a5b42f7ab122341fa71d774b`.
The package version remains `0.11.1`; existing release records are unchanged.

| Artifact | Value |
|---|---|
| Filename | `agents-can-communicate-0.11.1.tgz` |
| Packed size | 611,046 bytes |
| Files | 376 |
| sha256 | `9ad04e874ba98886e76ab9e6ddfed5ffac6d0b3f86302d21f331d1c16371e8c0` |

`npm pack --json` created the archive. `node scripts/verify-package.mjs` verified
that exact archive and reported PASS, including installed entry points, runtime
enrollment, and install/uninstall restoration. No package was published.

The focused TCP-discovery assertion failed against the previous implementation
because macOS arguments omitted `-b`, then all 13 desktop-delivery tests passed
with the correction. The Linux assertion retains its previous argument list.

This record covers the isolated adapter correction. Website code, build tools,
and tests belong to the separate private website repository.
