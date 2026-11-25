# Withdrawing a pending question or request: development evidence

This records #145 and its development candidate. It is not a published release. The design is
in [docs/design/2026-11-25-withdraw-pending.md](../design/2026-11-25-withdraw-pending.md).

## Change

- `acc withdraw --message <id> --reason <text>` withdraws a question or request that the caller
  sent. In one transaction it records a `note` with obligation `none` to each recipient that has
  not acknowledged the message, in the same thread, with subject `Withdrawn: <subject>`, the
  reason as body and `extensions.withdraws` naming the original.
- Each of those receipts becomes `acknowledged` with `extensions.withdrawn: {messageId, at}`, and
  each change appends a `message.acknowledged` event with `withdrawnBy` in its payload.
- Only the sender may withdraw, only a question or a request, and only while a recipient still
  owes an answer; otherwise the command exits 5. A repeated `--client-message-id` returns the
  recorded withdrawal.
- The six copies of the `acc` skill say when to withdraw.
- The store contract does not change: no receipt state, record field or event type is new. A
  message record now may carry `extensions`, which the schema already accepts.

## Older versions reading the store

ACC 0.15.6 from npm and this branch shared one isolated data home on macOS with Node 24.4.0.
The branch sent a question from `asker` to `alice`; 0.15.6 listed it in `alice`'s inbox and
reported `reply_required` attention for it. After the branch withdrew it, 0.15.6:
- listed only `Withdrawn: Port choice` in the inbox;
- reported no attention for the question;
- read the question exactly, with the receipt `acknowledged` and `extensions.withdrawn`;
- ran `status` and `doctor` without an error.

## Development candidate

- Source: clean commit `8a042f1b198f7ac7c58444e2b9d92a2f9d802b93`.
- `agents-can-communicate-0.15.6.tgz`, 678,668 bytes, 399 files.
- SHA-256: `95fa51c4f58fc4eb80ccbb6860bd00a515620c2672111fa51f232036fb5bd420`.
- The exact archive passed `scripts/verify-package.mjs`.

The exact archive was also installed with an isolated home and data home. A request withdrawn
with it left only `Withdrawn: Review the parser` in the recipient's inbox, and a second
withdrawal exited 5.

## Tests

- `packages/core/test/withdrawals.test.mjs`: a partly answered question, an exact read and a
  late reply, a retry, and refusals. Mutations that skip closing the receipt, close answered
  receipts too, skip the sender check, skip the retry or drop `withdrawnBy` each make a test fail.
- `packages/cli/test/withdraw-command.test.mjs`: the CLI in separate processes against one data
  home.
- `tests/process/surface-coverage.test.mjs` and `tests/process/session-resolution.test.mjs` cover
  the new command.
