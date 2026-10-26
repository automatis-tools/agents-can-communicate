# Development artifact: Antigravity TCP discovery

Captured on October 21, 2026 with Node 24.4.0 on macOS, and measured again on October 25,
2026 with Node 26.5.1 after merging `main` (#319, #321, #322). This is an unpublished
development artifact, built from `d11dc24083e30517eafc0bcbd40a5fa286665d3a`.
The package version remains `0.11.1`; existing release records are unchanged.

| Artifact | Value |
|---|---|
| Filename | `agents-can-communicate-0.11.1.tgz` |
| Packed size | 611,430 bytes |
| Files | 376 |
| sha256 | `b94ec6e4acd0a62008738fae5f2026ae1311634dbc42d3feab9357d8f60f5983` |

`npm pack --json` created the archive. `node scripts/verify-package.mjs` verified
that exact archive and reported PASS, including installed entry points, runtime
enrollment, and install/uninstall restoration. No package was published.

The focused TCP-discovery assertion failed against the previous implementation
because macOS arguments omitted `-b`, then all 13 desktop-delivery tests passed
with the correction. The Linux assertion retains its previous argument list.

This record covers the isolated adapter correction. Website code, build tools,
and tests belong to the separate private website repository.
