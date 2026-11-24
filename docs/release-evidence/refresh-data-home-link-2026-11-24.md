# An update keeps Codex hook trust with a linked data home: development evidence

This records the fix for #440 and its development candidate. It is not a published release.

## Cause

Install pins the data home into Codex's hook shim as the person configured it, for example
`export ACC_DATA_HOME="/tmp/x/d"`. Codex trusts its hooks plugin by a hash of the plugin's
bytes. An update refreshes the integrations from the runtime root that activation passes, and
that root is canonical. So the refresh wrote `/private/tmp/x/d` where install had written
`/tmp/x/d`. On macOS `/tmp` is a symbolic link to `/private/tmp`. The hooks plugin changed, ACC
moved it to a new version, and Codex asked to trust every ACC hook again.

The refresh now uses the configured data home while it leads to the runtime's own directory,
and the runtime's own data home otherwise. The refresh code is loaded from the version being
installed, so the fix applies to the update onto it.

## Development candidate

- Source: clean commit `09d03fffa3cd120cefd4a2974884d793a2dd607c`.
- `agents-can-communicate-0.15.4.tgz`, 671,552 bytes, 397 files.
- SHA-256: `1632423ae99a82267f78577ba46ee9565847639af160778abeb09385132730af`.
- The exact archive passed `scripts/verify-package.mjs`. See the note on its first run below.

## Unit tests

Two tests in `packages/cli/test/managed-runtime-refresh.test.mjs` refresh a Codex install whose
runtime root is canonical:
- with `ACC_DATA_HOME` set to a symbolic link to the data home, every hook shim keeps the link;
- with `ACC_DATA_HOME` set to another directory, every hook shim names the runtime's own data
  home.

Before the change, the first test failed with the resolved path in the shim, and the second
passed.

## Upgrade with real binaries

Setup: an isolated home, data home, npm prefix and cache under `/tmp/acc-link-<label>`, Codex
0.172.0 on `PATH`, and a local registry. Published 0.15.4 was installed with
`acc install --adapter codex --delivery off`, and `acc update --yes` then moved it to 0.15.5.

| Update target, served as 0.15.5 | Data-home line after the update | Hooks plugin |
|---|---|---|
| Published 0.15.4, re-versioned | `/private/tmp/acc-link-control/d` | moved to a new copy, new content hash |
| This candidate, re-versioned | `/tmp/acc-link-candidate/d` | kept its 0.15.4 copy and content hash |

The content hash was computed by a port of Codex's `plugin_fingerprint.rs`.

## Package verification

The first run of `scripts/verify-package.mjs` on this archive failed with "uninstall did not
restore client-home topology and bytes" in the Kimi Code install and uninstall step. That step
does not run the refresh path. Sixteen later runs of the same archive passed, nine of them three
at a time. The failure is filed as #442, which asks the check to name the differing entries.

## Limits

- No Codex session was opened, so the check proves the bytes that Codex trusts, not its trust
  dialog.
- A person who sets `ACC_DATA_HOME` to a different path that leads to the same directory gets
  that path in the shim at the next update, as install would write it.
