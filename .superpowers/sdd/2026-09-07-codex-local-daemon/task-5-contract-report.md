# Task 5 contract subset report

Scope: evidence validation and capture/checkpoint contracts only. This report does not claim
the full Task 5 harness, product matrix, real-client capture, certification enablement, or
release capability is complete.

## Implemented

- Added a closed scenario and run evidence validator for product cases `P01`–`P20` and
  transport cases `T01`–`T04`.
- Required exact client version, platform, role identifiers, ordered timestamps, package
  SHA-256, positive observations/assertions, final cleanup, closed observation vocabulary,
  exact phase matrices, and aggregate count consistency.
- Required P01 installed runtime and A/B cwd isolation facts without inventing an ACC
  participant or thread for daemon A.
- Required P04 to observe at least 150 seconds from `idleSinceAt` to `finishedAt`.
- Required P05 and T03 ordering:
  `preToolUseAt <= queuedAt < stopAt <= nextTurnAt`, plus active/pending/order facts.
- Required transport T01 exact binding, T02 idle acceptance, T03 busy acceptance, and T04
  rejected native submission with a durable queued receipt.
- Added `ordinary-command-with-installed-hooks` to the general capture contract while
  preserving old bootstrap captures. A passing installed-hooks capture now requires a full,
  passing, real-client product evidence aggregate with matching version and platform.
- Added a separate narrow transport capture schema. It is deliberately invalid under the
  product capture validator and cannot satisfy the installed-product evidence requirement.
- Extended the native-capture checkpoint with an associated
  `--product-evidence <client>=<absolute path>` input. Missing, invalid, transport-phase, or
  synthetic evidence makes an installed-hooks pass invalid.

## TDD and mutation evidence

The new evidence test first failed because the validator module was absent. The capture test
first failed on missing installed-hooks/transport exports. The checkpoint test then failed
until product evidence was parsed and passed to the validator. The T03 late-queue test was
observed failing with “Missing expected exception” before the ordering rule was added.

The focused evidence test mutates every required input and confirms the exact gate rejects it:

- empty product and transport scenario lists, and a missing P20;
- P01 receiver B actual cwd changed to daemon A, plus invented daemon participant identity;
- P05 and T03 `queuedAt` moved beyond the first `Stop`;
- omitted scenario and aggregate package SHA-256;
- zero observations, unknown/body/prompt/transcript fields, unknown outcomes, mismatched
  counts, unsuccessful cleanup, and missing T01–T04 required observations.

## Verification

```text
node --test tests/spikes/codex-local-daemon-evidence.test.mjs \
  tests/spikes/capture-contract.test.mjs \
  tests/spikes/native-capture-checkpoint.test.mjs

40 tests passed, 0 failed
```

The 0.152.1 transport artifact produced by the separately owned harness was checked
read-only with `assertRunEvidence`: transport, 4 cases, 14 assertions, cleanup passed. No
capture was fabricated or changed by this subset.

Syntax checks passed for all three owned production scripts, and `git diff --check`
reported no whitespace errors on the six owned implementation/test paths.

The whole suite was intentionally not run here because the root agent was concurrently
building the remaining Task 5 harness. A broad suite run remains the root agent's integration
gate after the scoped commits are assembled.
