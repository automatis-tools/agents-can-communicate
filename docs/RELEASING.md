# Releasing

```mermaid
graph LR
  A[npm ci] --> B[npm test] --> C[npm run check] --> D[npm pack] --> E[verify-package] --> F{approved?}
  F -->|yes| G[tag · publish · release]
  F -->|no| H[stop]
```

## Build the candidate

```bash
npm ci
npm test
npm run check
npm pack
node scripts/verify-package.mjs agents-can-communicate-*.tgz
git diff --check
```

`verify-package.mjs` is the gate that matters. It installs the tarball into a
clean directory with **no workspace anywhere** and then drives the product:
doctor, a non-Git workspace, an install and its removal.

Development cannot catch what this catches. Workspace symlinks are always
present there, so an unbundled package imports fine right up until somebody else
installs it.

## What it refuses

| Refused | Why |
|---|---|
| `tests/`, `test/` | test suite |
| `fixtures/` | capture material carrying paths from one machine |
| `.github/`, `.githooks/`, `.agents/` | local configuration |
| `*.jsonl` | looks like a transcript |
| Workspaces missing from `node_modules/` | every internal import would fail |

## Record the evidence

Put the tarball name, sha256, **the commit it was built from**, test counts,
capability matrix, and known limitations in `CHANGELOG.md`. A release without
them is a release nobody can audit later.

The commit is not optional detail. Every workspace travels inside the tarball,
so any change to shipped code changes the digest — a digest recorded alone goes
stale on the next merge and then reads as a false claim about the current tree
rather than a true one about an older commit. `verify-package.mjs` prints both
on one line for exactly this reason, and refuses to imply reproducibility when
the working tree is dirty:

```text
PASS  agents-can-communicate-0.0.0.tgz  sha256 a5c8bb1d…  built from 39d0dcf
```

`package.json` is part of shipped code for this purpose. npm packs the manifest
whatever `files` says, so a version bump or an `npm pkg fix` changes the digest —
and for a while the check watched every packed path except that one.

Once a version is published its record is history: it describes what the registry
serves and is not rewritten. Shipped code that changes afterwards gets a new
`## Unreleased` entry at the top of `CHANGELOG.md` carrying its own measurement.
The check reads the first record in the file, so an unreleased tree is held to
the same standard without disturbing the published one.

It went stale four times in a row anyway, each caught by hand and only because
someone happened to run the script. So `npm test` now checks it:
`tests/acceptance/recorded-candidate.test.mjs` fails when shipped code has
changed since the recorded commit, and names the files. A shallow clone that
does not have the commit reports that instead of failing — the check is of the
record, not of the checkout depth.

## Then stop

Publishing, tagging, and cutting a GitHub release are **external mutations**.
They need explicit approval from the maintainer, every time.

With two-factor authentication set to `auth-and-writes` — which is what `npm
profile get` reports for this account — every publish needs a code, and npm does
not prompt for one:

```bash
npm publish --otp=123456
```

An npm *Automation* token, or a granular token with write access, publishes
without a code. A granular token scoped to selected packages cannot create a
package that does not exist yet, which is the case exactly once per package. The `Release`
workflow builds and verifies a candidate and uploads it as an artifact; it does
not publish.
