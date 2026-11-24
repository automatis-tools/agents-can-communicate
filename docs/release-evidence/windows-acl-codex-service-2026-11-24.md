# ACC checks Codex service access on Windows by its access lists: development evidence

This records the fix for #445 and its development candidate. It is not a published release.

## Cause

Before ACC trusts or starts the Codex app-server service, it checks that no other account can
change the Codex home, the daemon directories or the two executables. That check read POSIX
owner and mode bits. On Windows Node has no owner and reports mode `0o40666` for every
directory and `0o100666` for every file, so the "writable by others" test was true for every
Codex home. `acc install` stopped with `unsafe_service_directory`, and Codex live delivery on
Windows never became ready.

On Windows the same paths are now checked by their access control lists. One PowerShell run
reads every list and the current user's SID. An allow rule with a write right for anyone but
the user, SYSTEM or Administrators makes a path unsafe, and so does another owner, who can
rewrite the list. A list that cannot be read is unsafe too, and so is a path with no list at all (a null DACL),
which grants everyone full access. On every platform a refusal now
names the path and what made it unsafe: the accounts on Windows, the mode or owner on POSIX.

## Measurements on GitHub's Windows runner

On 2026-11-24 a throwaway workflow ran Codex as a standard local user created in the job
(runs 45337316307 and 45341473502, `windows-latest`, Windows Server 2025):

- Codex 0.165.0 and 0.172.0 started their daemon for the standard user;
- Node reported mode `40666` for the Codex home, `app-server-control`, `app-server-daemon`
  and `packages` directories, and `100666` for the self-installed `codex.exe`;
- as the elevated runner account, `acc install --adapter codex --delivery actionable` stopped
  with `unsafe_service_directory`, and Codex refused to start the daemon: "start the Windows
  daemon from a non-elevated terminal".

## Development candidate

- Source: clean commit `07a3cd6d6d9a255575fc8216656ef4ca8ead5242`.
- `agents-can-communicate-0.15.4.tgz`, 674,823 bytes, 398 files.
- SHA-256: `b4c77491e0389270878a26761d622c3554a7584d2fb169acf807898c76c9ad11`.
- The exact archive passed `scripts/verify-package.mjs`.

## Tests

- `packages/adapter-sdk/test/windows-acl.test.mjs`: the writer rules for each write right, rules
  that do not apply to the path itself, owners, unreadable lists, the PowerShell order and the
  dropped module path. On Windows it also reads a real temporary directory. It makes the directory private with
  `icacls`, finds no other writer, grants Users a write right, and finds Users as a writer. On the
  CI runner the fresh temporary directory was not private: it inherits WriteData and AppendData
  for `BUILTIN\Users` from `D:\`. Finally it removes the access list (a null DACL, full access for everyone,
  which lists no rule) and finds Everyone as a writer.
- `packages/adapter-codex/test/service-setup.test.mjs`: on a Windows platform, a Codex home with
  mode `0o777` and private lists is prepared; a write right for Users on the Codex home is refused
  with the path and `BUILTIN\Users (S-1-5-32-545)`; an unreadable list is refused. On POSIX a
  Codex home with mode `0o777` is refused with its path and `mode 777`. All four failed before
  the change. A control-socket directory that is a file is refused with its path and "not a
  directory".

The end-to-end check that sends a peer message through the Windows daemon as a standard user is
#251.
