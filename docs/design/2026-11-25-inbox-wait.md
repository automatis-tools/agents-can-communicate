# A bounded wait on the inbox

Date: 2026-11-25. Issue #147. The maintainer's decision: the wait returns only for a message that
arrives after it starts. Messages already pending when it starts do not end it.

## Why

`acc inbox` returns the current page and exits. An agent that waits for a review verdict, or a
script that watches for the next message, must poll. Each poll starts the CLI again. The `acc`
skill tells agents to read the inbox, run `sleep 5` in the foreground, and repeat. Some clients
refuse a foreground `sleep`, and every round costs a tool call.

## Goals

- `acc inbox --wait <seconds>` returns as soon as a message addressed to the caller is recorded,
  or when the time passes. Both outcomes print the ordinary first page of the inbox.
- The wait holds no store lock and changes no receipt, as a plain `acc inbox` does not.
- The skill's review wait uses `--wait` in place of `sleep 5`.

## Non-goals

- A wait on `sync`. `sync` reports workspace events and attention, and its callers are hooks
  with a five-second budget. A watcher that wants messages wants the inbox. A wait on `sync` can
  follow if a caller needs one.
- A wait in the MCP `inbox` tool. MCP clients put their own time limits on a tool call, and a
  tool call that blocks for minutes looks hung there.
- Waking a client. `--wait` serves a caller that is already running and chooses to wait.

## Anti-goals

- A wait that a message which was already pending ends. One old unanswered request would then
  turn every wait into an immediate return, as the plain poll is now.
- A wait that holds the writer lock, or runs a store transaction on every poll. Hooks share that
  lock under a five-second budget.

## Approaches

1. **Watch the event log, without a lock (chosen).** At the start, read the position of the
   newest event. Then read the event log after that position, and only that, at a short interval.
   Stop at the first `message.recorded` event whose `recipientParticipantIds` names the caller.
   Then run one ordinary inbox read. The event log is append-only, and reading it takes no lock.
   This is the read `sync` already uses.
2. Repeat the inbox read on every poll and compare the message ids. This is simpler, but each
   poll is a store transaction under the writer lock. With a two-second poll that is thirty lock
   acquisitions a minute, beside hooks with five-second budgets.
3. A file system watcher on the event directory. It reacts faster, but `fs.watch` differs between
   macOS, Linux and Windows, and it can miss events. A poll still has to back it.

## Design

- **Command line.** `acc inbox --wait <seconds>`, a whole number from 1 to 600. Six hundred
  seconds is the longest a Claude Code shell command can run. `--wait` combines with `--limit`.
  It refuses `--message`, which reads one known message, and `--cursor`, which pages through
  older messages, with a usage error.
- **Result.** The usual page, `{items, nextCursor}`, plus `wait: {arrived, waitedMs}`. `arrived`
  is true when a new message for the caller ended the wait. The text form adds the line
  `no new message after <n>s` on a timeout. The exit code is 0 in both cases.
- **Store.** The filesystem store gains `eventCursor(workspaceId)`: the newest published
  sequence, read from the event directory's file names, below an open journal's ceiling, as
  `eventsSince` reads it. It reads no event file. The memory test store gains the same method. A
  store without it falls back to reading `eventsSince` to the end.
- **Core.** `waitForInbox(input)` checks the session like `listInbox`, takes the cursor, then
  reads `eventsSince(cursor)` every 500 milliseconds until a match or the deadline. A page of
  events without a match moves the cursor. A trimmed log moves the cursor to the floor. When the
  wait ends, it returns `listInbox` for the same session and limit.
- **Skill.** The six copies of "Stay available for an agreed review" read
  `acc inbox --wait 60` and repeat it, in place of `inbox` followed by `sleep 5`. An empty
  result is another wait, as before.
- **Interrupts.** Ctrl-C ends the wait like any other command. No state was changed, so there is
  nothing to undo.

## Left to the builder

- Where the core wait lives (the inbox service or a small module beside it), and how its clock and
  sleep are injected so that tests run on a mocked clock.
- The exact help text and the documentation pages that list inbox options.
