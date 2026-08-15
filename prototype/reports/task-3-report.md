# Task 3 report — immutable messaging and attachment evidence

## Status

Implemented the Task 3 message lifecycle and attachment-evidence boundary. Runtime code uses the reviewed `requireOpenAgent()` identity contract and keeps broadcast presence behind the injected `listActiveAgentIds()` callback.

## RED evidence

Command:

```text
node --test tests/tools/agent_comms/attachments.test.mjs tests/tools/agent_comms/messages.test.mjs
```

Result: exit `1`. Node reported `ERR_MODULE_NOT_FOUND` for both `tools/agents/lib/attachments.mjs` and `tools/agents/lib/messages.mjs`; 0 passed, 2 failed. No production Task 3 module existed at this point.

## GREEN evidence

Focused command:

```text
node --test tests/tools/agent_comms/attachments.test.mjs tests/tools/agent_comms/messages.test.mjs
```

Result: exit `0`; 18 passed, 0 failed. This includes 100 parallel sends producing 100 unique inbox records.

Full protocol regression:

```text
node --test tests/tools/agent_comms/*.test.mjs
```

Result: exit `0`; 55 passed, 0 failed.

Static/diff checks:

```text
node --check tools/agents/lib/messages.mjs
node --check tools/agents/lib/attachments.mjs
git diff --check
```

Result: all exit `0` with no diagnostics. Runtime sizes are 237 lines for `messages.mjs` and 101 lines for `attachments.mjs`, both below the 300-line limit.

## Files

- `tools/agents/lib/messages.mjs`
- `tools/agents/lib/attachments.mjs`
- `tests/tools/agent_comms/messages.test.mjs`
- `tests/tools/agent_comms/attachments.test.mjs`

## Requirement evidence

- Delivery records are exclusive immutable JSON files with compact UTC/sender/full-UUID ids.
- Sender and recipient must be open registry identities; no presence/heartbeat logic was duplicated.
- Seen receipts remain distinct from acknowledgements; acknowledgement is written before archive movement.
- Existing acknowledgements hide crash-left inbox sources and a repeated acknowledgement completes archival.
- Inbox type/severity filters preserve stored messages; replies create new linked records.
- Broadcast snapshots the injected active-id list, excludes the sender/inactive agents, creates one addressed copy per recipient, and archives acknowledgements independently.
- Direct, body-file, and stdin bodies produce identical stored body text.
- Repository and ephemeral attachments use canonical-path containment, streaming SHA-256, and actual stat size. Absolute paths, parent escapes, symlink escapes, missing files, mismatched evidence, and ephemeral commit claims fail with data errors.

## Self-review

- Checked the state transitions against the design: unseen → seen is delivery only; ack is the sole completion/archive transition.
- Checked the crash boundary: acknowledgement publication precedes `moveFileAtomic`, and an existing immutable ack is reused rather than overwritten.
- Checked concurrent delivery: each send obtains a full injected UUID and exclusive destination creation; the 100-send test detects loss and collision.
- Checked attachment trust boundary: caller checksum/size are never trusted by verification, and allowed-root comparison happens after `realpath`.
- Checked scope: no heartbeat, watcher, CLI, helper, schema, path, or identity implementation was added or duplicated.

## Concerns

None. Task 4/8 still need to supply the production `listActiveAgentIds()` presence callback and CLI body-source mapping at their planned integration boundaries.

## Fix Round 1

### Findings addressed

1. `sendMessage()` now calls `verifyAttachment()` for every attachment before the exclusive inbox write. Real send, reply, and broadcast tests cover missing files, symlink escape, and stale evidence respectively.
2. `markSeen()` now strictly reloads the persisted inbox record and requires deep equality with the supplied message before publishing a receipt. Altered and nonexistent schema-valid messages are rejected.
3. `listInbox()` now strictly reads seen/ack records and binds both `message_id` and `recipient` to the current message. `ackMessage()` applies the same binding to pre-existing and race-recovered acknowledgements. Corrupt and misaddressed receipts fail with exit `4` instead of hiding work.
4. Attachment classification now compares canonical paths against canonical `.agents/artifacts`; direct artifact paths and repository symlinks into artifacts cannot be claimed as non-ephemeral committed evidence.

The separately ledgered stat/hash race was deliberately not changed in this round.

### RED evidence

Command:

```text
node --test tests/tools/agent_comms/attachments.test.mjs tests/tools/agent_comms/messages.test.mjs
```

Result: exit `1`; 18 passed and 9 failed. Every failure was the expected `Missing expected rejection` for the four reported trust-boundary defects: two artifact-classification cases, three send/reply/broadcast attachment cases, fabricated seen, misaddressed seen, corrupt ack, and misaddressed ack.

### GREEN evidence

Focused command:

```text
node --test tests/tools/agent_comms/attachments.test.mjs tests/tools/agent_comms/messages.test.mjs
```

Result: exit `0`; 27 passed, 0 failed.

Full protocol command:

```text
node --test tests/tools/agent_comms/*.test.mjs
```

Result: exit `0`; 64 passed, 0 failed.

Static and structural checks:

```text
node --check tools/agents/lib/messages.mjs
node --check tools/agents/lib/attachments.mjs
git diff --check
wc -l tools/agents/lib/messages.mjs tools/agents/lib/attachments.mjs
```

Result: all checks exit `0`; runtime modules are 272 and 109 lines, both below 300.

### Fix-round self-review

- Verified evidence checks precede the only inbox publication call.
- Verified `markSeen()` reads inbox only, so an archived/completed message cannot gain a new seen receipt.
- Verified receipt binding is enforced both during inbox state derivation and idempotent acknowledgement recovery.
- Verified artifact provenance is derived after `realpath`, so lexical aliases and symlinks cannot change classification.
- Diff remains limited to the four Task 3 source/test files.

### Fix-round concerns

None beyond the explicitly excluded Minor stat/hash race.

Fix commit: `28820fa` (`fix: verify agent message evidence`).

## Fix Round 2

### Findings addressed

1. Added deliberate wrong-`recipient` seen and acknowledgement fixtures whose `message_id` remains correct. Both inbox suppression and idempotent ack paths are covered.
2. Reduced `messages.test.mjs` from 467 to 234 lines by moving reusable UUID/request builders, messaging fixture setup, agent seeding, and receipt seeding into the existing `helpers.mjs`. The shared helper is 278 lines. All message assertions remain in the single test file for `messages.mjs`; no extra test module or boilerplate exception was added.

### Recipient-mutation RED evidence

Temporary mutation: changed only the production binding condition from
`receipt.message_id !== messageId || receipt.recipient !== recipient` to
`receipt.message_id !== messageId`.

Command:

```text
node --test --test-name-pattern="wrong recipient" tests/tools/agent_comms/messages.test.mjs
```

Result with mutation: exit `1`; 0 passed, 2 failed. Both wrong-recipient tests failed with `Missing expected rejection`. The production recipient comparison was then restored unchanged.

Result after restoration: exit `0`; 2 passed, 0 failed.

### GREEN evidence

Focused command:

```text
node --test tests/tools/agent_comms/attachments.test.mjs tests/tools/agent_comms/messages.test.mjs
```

Result: exit `0`; 29 passed, 0 failed.

Full protocol command:

```text
node --test tests/tools/agent_comms/*.test.mjs
```

Result: exit `0`; 66 passed, 0 failed.

Structural commands:

```text
wc -l tests/tools/agent_comms/messages.test.mjs tests/tools/agent_comms/helpers.mjs
node --check tests/tools/agent_comms/messages.test.mjs
node --check tests/tools/agent_comms/helpers.mjs
git diff --check
```

Result: all checks exit `0`; line counts are 234 and 278. The tracked fix-round diff contains only `messages.test.mjs` and `helpers.mjs`; `tools/agents/lib/messages.mjs` has no residual diff from the temporary mutation.

### Fix-round self-review

- Confirmed the new tests preserve a correct message id while changing only recipient, so either half of the binding predicate has independent coverage.
- Confirmed the acknowledgement test exercises both `listInbox()` and `ackMessage()` with the wrong recipient record.
- Confirmed extracted helpers produce fixture inputs and seed immutable records only; they contain no assertions and do not duplicate production messaging behavior.
- Confirmed every touched `.mjs` file remains below 300 lines and the one-production-module/one-test-file layout is preserved.

### Fix-round concerns

None. The temporary production mutation was fully restored before the final runs.

Fix commit: `3d737cc` (`test: strengthen agent receipt coverage`).

## Cross-Task Fix Round 3

### Finding addressed

`markSeen()` now treats an exclusive-write conflict as an idempotent success only after strictly reading the already-published seen receipt and binding its `message_id` and `recipient` to the persisted message. Corrupt or mismatched existing records still fail with exit `4`. No acknowledgement or watcher code changed.

### RED evidence

Concurrent idempotency command:

```text
node --test --test-name-pattern="markSeen is idempotent" tests/tools/agent_comms/messages.test.mjs
```

Result before implementation: exit `1`; 0 passed, 1 failed. The second real concurrent `markSeen()` rejected with `CommsError: immutable record already exists`, exit `5`.

Strict-existing-receipt command:

```text
node --test --test-name-pattern="markSeen rejects (an existing|a corrupt)" tests/tools/agent_comms/messages.test.mjs
```

Result before implementation: exit `1`; 0 passed, 2 failed. Both cases received the old immutable-record conflict instead of the required DATA error.

### GREEN evidence

New regression command:

```text
node --test --test-name-pattern="markSeen (is idempotent|rejects an existing|rejects a corrupt)" tests/tools/agent_comms/messages.test.mjs
```

Result: exit `0`; 3 passed, 0 failed.

Message-focused command:

```text
node --test tests/tools/agent_comms/messages.test.mjs
```

Result: exit `0`; 23 passed, 0 failed.

Full protocol command:

```text
node --test tests/tools/agent_comms/*.test.mjs
```

Result: exit `0`; 78 passed, 0 failed, including the integrated Task 4 presence/watcher suite.

Structural commands:

```text
wc -l tools/agents/lib/messages.mjs tests/tools/agent_comms/messages.test.mjs
node --check tools/agents/lib/messages.mjs
node --check tests/tools/agent_comms/messages.test.mjs
git diff --check
```

Result: all checks exit `0`; runtime and test files are 280 and 267 lines.

### Fix-round self-review

- Verified the race uses two real concurrent writes against the same persisted inbox message and asserts both returned records plus the single stored receipt.
- Verified recovery catches only protocol conflict, then strictly parses and identity-binds the winner's record before returning it.
- Verified corrupt JSON and wrong-recipient receipts remain DATA failures instead of becoming idempotent successes.
- Verified the diff is limited to `messages.mjs` and `messages.test.mjs`; acknowledgement and watcher code are untouched.

### Fix-round concerns

None.

Fix commit: `f8d672d` (`fix: make seen receipts idempotent`).
