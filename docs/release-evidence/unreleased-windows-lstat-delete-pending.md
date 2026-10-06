# Unreleased: a Windows writer looks again when the lock's record is being deleted

| Candidate artifact | Value |
|---|---|
| Built from | `eeba358929d1acbae4534491201141272fbae0fb` |
| Tarball | `agents-can-communicate-0.9.1.tgz`, 576,882 bytes, 351 files |
| sha256 | `4bb33aa276aaac59e79132b7bbf4dbfdb710e5d8c2a3fae68a88f37d115c359d` |

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

A loop of that test on windows-latest, four loops of 150 beside each other (run 37500277861):
main failed 11 of 600, each with `EPERM … lstat` on the owner record. With the lstat refusals
settled it failed 1 of 600, with `EPERM … open`. The open was refused while the record was
deleted, and when the name was looked at again the lock had a new owner and the name a new
file, so the refusal was kept as if the name had refused it.

## What changed

- `storage-filesystem/src/portable-fs.mjs`, and its byte-identical copy in
  `cli/src/managed-runtime/`: `lstatSettled` asks a name that answers EPERM again, within the
  caller's deadline (two seconds when it names none). `openNoFollow` uses it before the open,
  after the open, and when it decides whether a name that refused the open is gone. An absent
  name reads as absent, a present one is checked as before, and an EPERM that outlasts the
  deadline is kept.
- After an open refused with EPERM, a name that now names another file changed hands and is
  opened afresh, up to the three swaps a name changing after the open is allowed. A name still
  naming what it named keeps its EPERM.

## Tests

`packages/storage-filesystem/test/portable-fs.test.mjs`, with the Windows fakes. The first three
failed on main's `portable-fs.mjs`:

- a name refused to lstat while its directory is deleted reads as absent;
- a name refused to lstat for a moment is opened once it answers;
- an open refused while the name is deleted, and lstat refused too, reads as absent;
- an lstat refusal that outlasts the deadline keeps its EPERM, and the name is never opened;
- an open refused while the lock changed hands opens the new record (failed before the second
  change);
- an open refused while the name keeps changing hands keeps its EPERM after three opens (failed
  before the second change, which opened once).
