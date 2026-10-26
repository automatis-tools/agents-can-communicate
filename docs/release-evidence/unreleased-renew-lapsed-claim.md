# Development artifact: a lapsed claim is acquired again

Captured on October 25, 2026 with Node 26.5.1 on macOS. This is an unpublished
development artifact, built from `0602db2516cef4e4250687e6a53541f683ec6689`.
The package version remains `0.11.1`; existing release records are unchanged.

| Artifact | Value |
|---|---|
| Filename | `agents-can-communicate-0.11.1.tgz` |
| Packed size | 611,255 bytes |
| Files | 376 |
| sha256 | `5f2cd01290c24dd414ec4c58c6583e6092460981cea865d5ebe7be278ef6a36b` |

`npm pack --json` created the archive. `node scripts/verify-package.mjs` verified
that exact archive and reported PASS, including installed entry points, runtime
enrollment, and install/uninstall restoration. No package was published.

## Reproduction from #295

Two `acc-mcp` stdio servers, participants `alice` and `bob`, one workspace and data
home, run from the source checkout:

| Step | `main` at `8bfb53f3` | This change |
|---|---|---|
| 1. alice acquires `file:src/app.ts` exclusively, `leaseSeconds: 1` | ok | ok |
| 3. after 2 s, bob acquires it exclusively | ok | ok |
| 4. alice renews her lapsed claim, `leaseSeconds: 600` | succeeded | refused: `claim <id> has lapsed; acquire the resource again` |
| 5. live exclusive claims on the resource | 2 (bob, alice) | 1 (bob) |
| 6. bob acquires again, which renews his claim | `the resource is already claimed` | ok |

The two new tests in `packages/core/test/claims.test.mjs` failed against the previous
implementation with `Missing expected rejection` and pass with the correction: a
lapsed claim taken by another session, and a claim at its exact expiry, which
acquiring takes back under the same claim id.
