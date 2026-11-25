# Withdrawing a pending question or request

Date: 2026-11-25. Issue #145. The maintainer's decision: a withdrawal closes the recipient's
receipt, with a mark that the sender withdrew it and why, so that older ACC versions that share
the store stop showing the message too.

## Why

Only a decision can be withdrawn. A question or request that its sender no longer needs stays
in the recipient's inbox and attention until someone answers it. This includes a message to a
session whose client exited: it waits there until the session returns, and its next turn then
spends tokens on a question nobody needs any more. The sender has no recorded way to cancel it.

## Goals

- The sender withdraws its own question or request with a reason:
  `acc withdraw --message <id> --reason "<text>"`.
- Each recipient that has not answered stops owing an answer: the message leaves the inbox and
  attention, also in older ACC versions.
- Each such recipient receives a note with the reason, in the same thread.
- The original message, the receipts and the reason stay in history.
- A message that every recipient already answered is refused with a clear error.

## Non-goals

- Withdrawing a note, an answer, a handoff or a decision. Decisions keep `--withdraws`.
- An MCP tool. The CLI comes first; a tool can follow when an MCP-only client needs it.
- Undoing a withdrawal. The sender asks again with a new message.

## Anti-goals

- A new receipt state, record field or event type. ACC 0.15.x sessions on older generations
  read the same store, and their validation rejects anything unknown.
- A withdrawal that a recipient cannot see. A recipient that already read the question may be
  working on it; the note tells it to stop.

## Approaches

1. **Close the receipt, with a mark in its extensions (chosen).** The withdrawal advances each
   pending receipt to `acknowledged` and records `extensions.withdrawn: {messageId, at}`. Older
   versions read an acknowledged receipt and drop the message from inbox and attention. The
   mark keeps the withdrawal distinguishable from an acknowledgement.
2. Leave the receipt and derive "withdrawn" from the withdrawal note, as decisions derive their
   status. The receipts stay true to the recipient's actions, but older versions keep showing
   the question, and inbox, attention, status counts and the router all need the new rule.

## Design

- **Command.** `acc withdraw --message <id> --reason "<text>"`, with the usual owner flags and an
  optional `--client-message-id`. Only the participant that sent the message may withdraw it.
  The message must be a `question` or a `request` in this workspace.
- **One transaction.** It records a `note` with obligation `none`, addressed to the recipients
  whose receipts are not yet `acknowledged`. The note replies in the original thread
  (`inReplyTo` is the original), its subject is `Withdrawn: <original subject>`, its body is the
  reason, and `extensions.withdraws` names the original. Each of those receipts becomes
  `acknowledged`, keeps its other extensions and gains `withdrawn: {messageId: <note>, at}`. Each
  change appends the existing `message.acknowledged` event, with `withdrawnBy: <note>` in its
  payload.
- **Refusals.** A message from another participant, or of another kind, exits 5 (conflict). A
  message with no pending receipt exits 5 with "every recipient already answered or
  acknowledged this message". An unknown message id exits 5, as `reply` does.
- **Retry.** A repeated `--client-message-id` returns the recorded note without changing
  anything, also after the receipts were closed.
- **Delivery.** The note goes through the ordinary router, as any note does: it waits for the
  recipient's next turn and wakes nobody.
- **Reading.** An exact read of the original shows the receipt as `acknowledged` with
  `extensions.withdrawn`. A recipient may still reply to it; replying after an acknowledgement
  is allowed today.
- **Skill.** One short paragraph under "Communicate only when it changes another agent's work"
  says when and how to withdraw.

## Left to the builder

- Module layout in the core and the CLI, and the exact help text.
- How the result reads in text form; the JSON carries the note, its delivery and the withdrawn
  receipts.
