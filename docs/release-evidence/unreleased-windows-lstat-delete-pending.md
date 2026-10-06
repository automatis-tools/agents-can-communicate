# Unreleased: a Windows writer looks again when the lock's record is being deleted

| Candidate artifact | Value |
|---|---|
| Built from | `776f6b31cc4d1004ab86af469aef7ade6523b8b7` |
| Tarball | `agents-can-communicate-0.9.1.tgz`, 576,801 bytes, 351 files |
| sha256 | `d50bf5e4a315133df3700288f082dcffa55c173055593bdeaecaa8e762d8b95b` |

## What was measured before the change

On windows-latest, 2026-10-06, after the suite moved to three files at a time:

- main at `b50729e9`, CI job 112337586683: `hook-turn-lifecycle-packed` failed with
  "cannot safely open regular file".
- PR #265 with main merged, `92655495`, CI job 112337758940: `transaction-read-cost`
  failed with the same error, from `withWriterMutex` → `readOwner`.
- The error hid its cause. A measurement branch put the OS error into the message and ran eight
  suites (run 37497822539): one failed, in "concurrent owner publication elects one live
  writer", with `EPERM: operation not permitted, lstat '…\locks\writer.lock\owner.json'`.

On Windows a waiting writer removes an emptied lock with `rmdir`. A path inside a directory
being deleted answers EPERM until the deletion is done. `openNoFollow` turned an EPERM from
`open` into ENOENT when the name was gone, but passed an EPERM from its own `lstat` on.
Then the read failed, and so did the writer that should have looked again.

## What changed

- `storage-filesystem/src/portable-fs.mjs`, and its byte-identical copy in
  `cli/src/managed-runtime/`: `lstatSettled` asks a name that answers EPERM again, within the
  caller's deadline (two seconds when it names none). `openNoFollow` uses it before the open,
  after the open, and when it decides whether a name that refused the open is gone. An absent
  name reads as absent, a present one is checked as before, and an EPERM that outlasts the
  deadline is kept.

## Tests

`packages/storage-filesystem/test/portable-fs.test.mjs`, with the Windows fakes. The first three
failed on main's `portable-fs.mjs`:

- a name refused to lstat while its directory is deleted reads as absent;
- a name refused to lstat for a moment is opened once it answers;
- an open refused while the name is deleted, and lstat refused too, reads as absent;
- an lstat refusal that outlasts the deadline keeps its EPERM, and the name is never opened.
