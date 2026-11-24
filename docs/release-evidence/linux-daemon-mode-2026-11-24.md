# A world-writable Codex daemon on Linux is refused with its repair: development evidence

This records the fix for #446 and its development candidate. It is not a published release.

## Cause

Before ACC trusts or starts the Codex app-server service, it checks that no other account can
change the Codex home, the daemon directories or the two executables. Codex 0.165.0 and 0.172.0
install the Linux daemon executable,
`packages/app-server-daemon/releases/<version>/bin/codex`, with mode `0777`. Any local account
that can reach the file can replace the daemon, which then runs as the user. ACC refused it with
`unsafe_service_executable`, which is correct, but a person could not tell from the refusal what
to change.

The refusal now names the file and its mode and gives the repair:
`run chmod go-w "<file>", then retry acc install`. ACC does not change the file itself: it
belongs to Codex, and a silent repair would hide a vendor defect. A path owned by another
account gets no `chmod` advice, because its owner, not the user, must change it.

## Measurements on GitHub's runners

On 2026-11-24 a throwaway workflow started the Codex daemon in a fresh Codex home (run
45341473502, `ubuntu-latest` and `windows-latest`):

- Linux, Codex 0.172.0 (`x86_64-unknown-linux-musl`): `bin/codex` mode `100777`; the Codex home,
  `packages`, `app-server-daemon` and the release directory mode `40755`;
  `app-server-control` and `app-server-daemon` state directories mode `700`. Codex 0.165.0 gave
  the same modes.
- macOS, Codex 0.172.0: the same file has mode `755`.

## Development candidate

- Source: clean commit `04055c1505129e8b2b2aa1ec38d617d811181378`.
- `agents-can-communicate-0.15.4.tgz`, 675,007 bytes, 398 files.
- SHA-256: `516a30ecbbad3f28b683e66326ce4510d97574d5637d71a3cc68cdf9381d9360`.
- The exact archive passed `scripts/verify-package.mjs`.

## Tests

`packages/adapter-codex/test/service-setup.test.mjs`:

- a daemon executable with mode `0o777` is refused with `unsafe_service_executable`, its path,
  `mode 777` and `run chmod go-w "<file>", then retry`; the file's mode is unchanged afterwards.
  It failed before the change;
- a service path owned by another account is refused with its owner and no `chmod` advice.

The end-to-end check that installs ACC against a real Linux Codex daemon is #251.
