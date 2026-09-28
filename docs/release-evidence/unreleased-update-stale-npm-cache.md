# Unreleased: an update right after a release

## What was measured

On 2026-09-28, right after 0.8.2 was published, `acc update` on the maintainer's machine
(ACC 0.8.1, npm 11.17.0, macOS arm64) failed with `npm error code ETARGET` and `No matching
version found for agents-can-communicate@0.8.2`. The working runtime was kept.

- Discovery asks the registry directly for `agents-can-communicate/latest`, and it received
  0.8.2. The download then runs `npm install agents-can-communicate@0.8.2`, and npm reads the
  package document through its own HTTP cache.
- The registry lists a release after it has processed it: `time["0.8.2"]` is 22:24:47Z. npm had
  cached the package document, without 0.8.2, at 22:22:54Z from an `npm view` run while the
  publish was still being processed. The registry sends that document with
  `cache-control: public, max-age=300`, so npm treated the cached copy as fresh until 22:27:54Z.
- The update at 22:25:57Z logged `http cache https://registry.npmjs.org/agents-can-communicate
  (cache hit)` and ETARGET. The same update at 22:27:18Z with `npm_config_prefer_online=true`, with
  that cache entry still fresh, logged `(cache updated)` and activated 0.8.2.

An npm command that caches this package's document before the registry lists a release, as
`npm view` did here, opens the same window for up to five minutes.

## What changed

`packages/cli/src/managed-runtime/download.mjs`: the download runs `npm install
--prefer-online`, so npm revalidates cached package documents with the registry. The version
comes from discovery as before, and the downloaded archive is still checked against the
integrity that discovery returned.

## Tests

`tests/acceptance/managed-update-stale-npm-cache-packed.test.mjs`, "packed update installs a
discovered release while npm still caches a document that does not list it". The update
registry fixture can now send the package document with the public registry's `max-age` and
serve it before the release is listed. The test runs `npm view` against the unlisted document
with the update's npm cache, then lists the release and runs `acc update`. It asserts that the
update activates the release and that the download asked the registry for the document again.
On the unchanged code it failed with the measured error: `npm error code ETARGET`, `No matching
version found for agents-can-communicate@0.8.3`.

## Exact local artifact

- Source: clean commit `2fff1e9178906f1ff4712e9ce7aeaf03a51fde68` on
  `fix/update-stale-npm-cache`, from `main` at `9c219e6` (0.8.2).
- Archive: `agents-can-communicate-0.8.2.tgz`, packed from that commit.
- Size: 486,544 bytes; 315 packed entries.
- SHA-256: `fb14d6fada097e43c0bd2cce870e5d7e1fe1908ce45b4786e9ddbc02ed340a77`.
- Package version remains `0.8.2`; this is an unpublished development artifact.

The exact archive passed `scripts/verify-package.mjs`.
