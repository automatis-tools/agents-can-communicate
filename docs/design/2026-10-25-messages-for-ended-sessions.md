# Messages left for a session that ended

Date: 2026-10-25. Issue #320, from discussion #180.

## Problem

A message waits in its recipient's inbox until that participant reads it. When every
session of the recipient has ended, nothing reads it. A new session of the same client
is a different participant and does not inherit that inbox. Attention tells nobody:

- the new session's attention covers only its own receipts;
- the sender sees `recipient_unavailable` only while the message has an obligation,
  and an `answer` has none.

In the run reported in discussion #180, Claude asked Codex for a review, Codex replied,
and the reply stayed `queued`. A core reproduction on 0.11.1 gives the same result: the
reply stays `queued` for the closed session, and attention is empty for the next Claude
session and for Codex.

## Decision

A new attention kind, `left_for_ended_session`, tells the other sessions in the room
that such a message exists and how to read it.

- **Who is told.** Every participant that is neither the sender nor a recipient of the
  message. The sender wrote it and, while it carries an obligation, already sees
  `recipient_unavailable`; a co-recipient holds the message in its own inbox. Knowledge
  is shared; authority is not: a session that is told cannot acknowledge or answer on the
  recipient's behalf.
- **Which messages.** All of these hold:
  - the message is current (a superseded or withdrawn decision does not count) and is
    addressed to participants, not to the room;
  - the recipient's receipt is `queued` or `offered`, so the recipient never retrieved it;
  - no session of the recipient is `online` or `stale`. Presence is the existing
    classification: a closed session, a dead pid, a heartbeat past the hard expiry or an
    unknown pid past its expiry is `offline`. A paused session is `stale` and does not
    count, because it can still return to its inbox;
  - the message was sent within the last 7 days (`LEFT_MESSAGE_WINDOW_MS`).
  Any obligation counts, including `none`: the reply in #180 had none.
- **Once per participant.** A participant is told about a message once. When a hook's
  context carries the item, the post-write commit that records message offers also records
  the message id in the session record's `extensions.noticedLeftMessages`. Attention omits
  a message that any session of the same participant has recorded: a resumed conversation
  opens another session of the same participant, and its transcript already holds the
  notice. The real-client capture found this case, when the first design counted per
  session. Each list keeps the 64 newest ids.
- **Bounded.** The 5 newest qualifying messages (`LEFT_MESSAGE_LIMIT`) are chosen first,
  and those the participant was already told about are then dropped. Choosing after the
  drop let a backlog longer than the 64-id list cycle through it on every prompt (found in
  review). `acc status`, which has no session, shows the same 5 newest. The receipts are
  read in one pass, so a hook's cost stays linear in what the workspace holds.
- **Text.** The summary carries validated ids only: the message kind, the sender, the
  recipients, and how to read it, `` `acc sync --scope history --message <id>` ``, which
  changes no receipt. The subject is peer-written and the line speaks in ACC's voice
  outside any quoted peer block, so the subject stays out (found in review).
- **Priority.** `left_for_ended_session` ranks after the claim kinds (priority 7). It is
  informational: the context projector places it after peer bodies and reminders.
- **The recipient comes back.** When the recipient participant returns (a resumed
  conversation keeps its participant), its session is `online`, the item stops
  qualifying, and the recipient reads its inbox as usual.

## Compatibility

Attention is computed when it is read; no store record kind changes. The notice list lives in the session record's `extensions`, which an older ACC carries through
unchanged, since every session update spreads the current record. An older ACC reading
the same store shows no `left_for_ended_session` items and ignores the list.

## Text

Every installed agent skill, under "Act on attention", and `docs/PROTOCOL.md` describe the
kind: read the message with `sync --scope history --message <id>`, act on it only within
your own user's scope, and leave the receipt to its recipient.

## Verification

- Core tests with the memory store: the #180 sequence (request, reply, recipient
  closes, new session); a recipient whose session is only `stale` is not reported; the
  sender is not told; a reported message is not reported again to the same participant,
  including its resumed conversation;
  the newest 5 are reported when more qualify; a message older than the window is not
  reported; a superseded decision is not reported.
- A hook-runner test: the post-write commit records the notice only when the item
  reached stdout, as it does for offers.
- A real-client capture: Claude Code and Codex on an isolated data home. Claude asks
  Codex for a review and exits; Codex replies; a new Claude session in the same
  project receives the notice and reads the reply through history.
