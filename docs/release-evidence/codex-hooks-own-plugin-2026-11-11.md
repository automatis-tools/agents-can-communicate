# Codex hooks in their own plugin: development evidence

This records the development candidate that moves ACC's Codex hooks into a plugin of their own,
so an ACC update no longer makes Codex ask to trust them again. It is not a published release.

## Exact artifact

- Source: clean commit `9aa2ceb5fc1afd0b25d5527c81f06204ff8a701c`.
- Archive: `agents-can-communicate-0.15.0.tgz`, 658,915 bytes, 392 files.
- SHA-256: `eedd261280ce718ae28cd6e7feec6eb574e4c05f02e267161fcc2dd0824a058b`.
- Node 24.4.0, npm 11.4.2, macOS arm64.

The exact archive passed `scripts/verify-package.mjs`.

## Cause, measured before the change

On the maintainer's machine, Codex CLI 0.167.1 recorded one `trusted_content_hash` for all five
ACC hooks. It changed from `sha256:c1717439…` (0.14.1) to `sha256:4a04808e…` (0.15.0), while each
hook's `trusted_hash` stayed the same. The two cached plugin copies differed only in the
`version` field of `.codex-plugin/plugin.json`. A port of Codex's
`plugin_fingerprint.rs` over the two copies gave exactly those two hashes.

## Behaviour covered by tests

- An install with a new ACC version and unchanged hooks leaves the cached hooks plugin and its
  Codex content hash byte for byte the same, and the marketplace copy names the same version.
- A changed hook shim gets the new version, and the copy it replaces is removed.
- An update from the single plugin leaves no hooks in the skill's plugin.
- Unmarked-config adoption accepts the new plugin table, and an install from before it.
- Each new test fails on the change it guards: always stamping the running version, keeping
  the old hooks behind in the skill's plugin, dropping the hooks table from adoption.

## Real client

Codex CLI 0.167.1, macOS arm64, isolated `HOME`, `CODEX_HOME` and ACC data home, TUIs driven
through a PTY. The exact archive above was re-versioned to 0.15.93 and 0.15.94, and the update
was served from a local registry.

- A fresh install asked once to review the five hooks of `agents-can-communicate-hooks@acc-local`.
  The `trusted_content_hash` Codex recorded equals the port's hash of the cached copy.
- With a Codex session open, `acc update` to 0.15.94 left the hooks copy at 0.15.93 with the
  same hash. The open session ran the hooks on its next prompt, `/hooks` listed them active, and
  the session joined ACC. A new session showed no review.

An earlier build of the same change was also run from published 0.15.0. A session open across
that update listed no hooks until it restarted, and the next session asked once. See
`packages/adapter-codex/COMPATIBILITY.md`.

## Limits

- Linux and Windows Codex were not run. The Windows hook command is covered by unit tests only.
