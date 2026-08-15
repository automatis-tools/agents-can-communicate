# Task 6 report — Evidence-bearing handoffs

## Delivered

- Added `createHandoff(context, input)`, which validates canonical handoff evidence,
  writes one immutable handoff record, and then sends one addressed `handoff` message
  requiring acknowledgement.
- Artifact evidence is verified against its supplied checksum and byte size before
  publication, then re-described canonically for the record and its message.
- A passing committed handoff is `READY`; a failed verification is retained as
  `NOT_READY`; an uncommitted handoff is visibly `UNCOMMITTED` and never ready to merge.
- If message delivery fails after publication, the immutable handoff record remains in
  `.agents/handoffs/` for diagnosis. It is deliberately not deleted or rewritten.

## Evidence gate

RED, before implementation:

```text
$ node --test tests/tools/agent_comms/handoff.test.mjs
ERR_MODULE_NOT_FOUND: Cannot find module .../tools/agents/lib/handoff.mjs
exit 1
```

The committed-input test deliberately passes `verification: []` and asserts the
protocol data-gate result: `error.exitCode === EXIT.DATA` (`4`) and an error message
containing `verification`. This is exercised in the focused and full green runs.

## Verification

```text
$ node --test tests/tools/agent_comms/handoff.test.mjs
pass 6, fail 0

$ node --test tests/tools/agent_comms/*.test.mjs
pass 107, fail 0

$ git diff --check
exit 0
```

## Scope

Only `tools/agents/lib/handoff.mjs` and
`tests/tools/agent_comms/handoff.test.mjs` are committed for this task.
