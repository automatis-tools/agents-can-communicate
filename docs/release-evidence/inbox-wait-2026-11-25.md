# A bounded wait on the inbox: development evidence

This records #147 and its development candidate. It is not a published release. The design is
in [docs/design/2026-11-25-inbox-wait.md](../design/2026-11-25-inbox-wait.md).

## Change

- `acc inbox --wait <seconds>`, 1 to 600, returns the first inbox page once a message for the
  caller is recorded after the wait starts, or when the time passes. The page adds
  `wait: {arrived, waitedMs}`. A timeout exits 0, and the text form ends with
  `no new message after <n>s`. `--wait` refuses `--message` and `--cursor`.
- The core reads the event log from the newest event at the start, every 500 milliseconds,
  and stops at a `message.recorded` event that names the caller. The wait's time starts once
  that starting point is read, so a message recorded during the read counts as pending. Reading the event log takes
  no store lock. One ordinary inbox read follows.
- The filesystem store gains `eventCursor`: the newest published event, from file names
  alone, below an open journal. It reads the journal after listing the files, so a journal
  opened in between cannot let the cursor pass an event of an unfinished transaction.
- The six copies of the `acc` skill repeat `inbox --wait 60` for an agreed review wait, in
  place of an inbox read and a foreground `sleep 5`.
- The store contract does not change: no record field, event type or receipt state is new.

## Development candidate

- Source: clean commit `2f4990da1e667c454004ecaa4b7d775d27fe1c6a`, this branch merged with `main`
  after #457 (`acc withdraw`).
- `agents-can-communicate-0.15.6.tgz`, 680,909 bytes, 401 files.
- SHA-256: `6edaa38ca8c577e8c8746df66302f8558a584f1f738ed6c218efef5d9dd2b8d8`.
- The exact archive passed `scripts/verify-package.mjs`.

The exact archive was also installed with an isolated home and data home, on macOS with Node
24.4.0. Two attached participants ran it:
- with one question already pending, `acc inbox --wait 3` returned after 3 seconds and ended
  with `no new message after 3s`;
- `acc inbox --wait 60` returned about 2 seconds after a peer sent a question, with
  `arrived: true` and both questions on the page.

## Tests

- `packages/storage-filesystem/test/event-cursor.test.mjs`: the cursor of an empty log, of a
  written log, of a log trimmed away entirely, and with an event file published under an open
  journal. Removing the journal ceiling or the trimmed boundary makes a test fail.
- `packages/core/test/inbox-wait.test.mjs`, on a fake clock: arrival, an already pending
  message, a message for another participant, no receipt or event change, a trim during the
  wait, a burst of more than one page of events, a slow starting read, and refusals. The wait
  tests use the core's `eventsSince` fallback for the starting point. Mutations of the
  recipient check, the starting cursor, the session check, the paging and the start time
  each make a test fail.
- The order of the journal read and the listing in `eventCursor` has no deterministic test:
  the race needs a journal opened between two reads of one call, and the store has no seam
  there. The open-journal test covers the ceiling itself.
- `packages/cli/test/inbox-wait-command.test.mjs`: the CLI in separate processes, arrival
  during the wait, a timeout, and option refusals.
