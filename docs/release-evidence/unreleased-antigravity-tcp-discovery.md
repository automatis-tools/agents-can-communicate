# Development artifact: Antigravity TCP discovery

Captured on October 21, 2026 with Node 24.4.0 on macOS, and measured again on October 25,
2026 with Node 26.5.1 after merging `main` (#319, #321, #322, #324, #326). This is an unpublished
development artifact, built from `463b4c6f6de0a85ce1c798910615b91f28c96c05`.
The package version remains `0.11.1`; existing release records are unchanged.

| Artifact | Value |
|---|---|
| Filename | `agents-can-communicate-0.11.1.tgz` |
| Packed size | 613,912 bytes |
| Files | 378 |
| sha256 | `e2596970e36b23811f6141d4acdb98d902666b0dbcb9dafbdd881c333f0fbeb6` |

`npm pack --json` created the archive. `node scripts/verify-package.mjs` verified
that exact archive and reported PASS, including installed entry points, runtime
enrollment, and install/uninstall restoration. No package was published.

The focused TCP-discovery assertion failed against the previous implementation
because macOS arguments omitted `-b`, then all 13 desktop-delivery tests passed
with the correction. The Linux assertion retains its previous argument list.

This record covers the isolated adapter correction. Website code, build tools,
and tests belong to the separate private website repository.
