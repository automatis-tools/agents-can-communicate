# Unreleased: Codex sender permission recovery

Issue [#285](https://github.com/automatis-tools/agents-can-communicate/issues/285).

| Candidate artifact | Value |
|---|---|
| Built from | `9f86a40ba2fdb87b3d89fa1e0061cef1ad4a6d35` |
| Tarball | `agents-can-communicate-0.10.3.tgz`, 583,402 bytes, 351 files |
| sha256 | `858127d3d57d07ca66e720a44dfdc3d7bac8078ab9ef79de9dfd21e9bb2dba97` |

This is an unpublished development candidate. The package version stays `0.10.3`.
The existing release records retain their original artifact provenance.

## Reproduction and correction

On macOS arm64 with Codex 0.162.0, the sender sandbox denied `lstat` of the daemon
socket with `EPERM`. The installed ACC permission profile and additional isolated
socket grants did not remove the denial. Outside the sandbox, the same receiver
passed verification. ACC previously reported the metadata denial as
`recipient_unavailable`, before it attempted a connection.

The candidate preserves `transport_permission_denied` for denied endpoint reads,
socket metadata, and connections. The router preserves and records that reason
when an expired binding cannot refresh. The CLI prints the original retry key.
The Codex skill uses the approved exact-wrapper execution path for outgoing
commands. An initial execution refusal is distinct from a recorded send.

## Installed-artifact capture

[The machine-readable capture](codex-sender-permissions-0.162.0.json) records this
sequence against a real Codex 0.162.0 daemon:

1. The candidate was packed and installed in a clean temporary consumer.
2. A test thread started idle, with an expired ACC delivery binding.
3. The sandboxed CLI send recorded one question and reported a permission denial.
4. Approved execution retried the identical command with the same client message ID.
5. The original message was offered through `codex-app-server`.
6. The receiver started automatically and wrote its authorized marker without another prompt.
7. Another retry produced no additional recorded message or successful offer.
8. The test thread was archived and the temporary fixture removed.

The journal contained one recorded message, one failed offer, and one successful
offer. The marker was observed at 23:00:27 UTC on 2026-10-08.

The isolated installer used a 0.153.4 detection shim to avoid service preparation.
The receiver and delivery protocol were the real 0.162.0 daemon. Receiver
registration used the candidate adapter and core APIs. Startup hooks and automatic
approval-rule matching were not re-measured. Windows, Linux, and delivery inside
an active turn were not captured. No daemon restart or permission relaxation was
part of the correction.

## Regression evidence

The new filesystem-denial tests failed before the fix with `recipient_unavailable`.
The connection-refresh tests failed with `handshake_failed`. The expired-binding
router test also failed with `recipient_unavailable`.

After the fix, restoring the old permission-swallowing behavior made the real
filesystem-denial tests fail again. Restoring the fix made them pass. Retry tests
verify one durable message and one successful offer for both current and expired
bindings. CLI tests check the retry key and its shell quoting.

A reference-skill probe selected default sandbox execution before the guidance.
A fresh probe selected approved execution and reused the original retry key after
reading the new guidance. Independent review found one ambiguous statement about
initial execution refusal. That statement was corrected and reviewed again.

The test runner also removes inherited `CODEX_HOME` and `AGENTS_HOME` from its
child environment. The baseline suite exposed this isolation defect by redirecting
fixture installs into the calling client's setup. A new guard test failed before
the correction. The affected local ACC integration was restored with explicit
user approval and verified afterward.

## Final gates

- `npm ci`: passed.
- `npm run check`: passed, 740 tracked modules checked.
- `npm test`: 3,222 tests, 3,214 passed, 8 skipped, 0 failed.
- The recorded artifact passed `scripts/verify-package.mjs`, including clean
  installation and removal with client-home topology restored.
- The permission-swallowing mutation failed the new filesystem-denial tests.
- Independent review completed with no remaining blocker.

The initial baseline run failed seven installation checks because it inherited
`CODEX_HOME`. The corrected runner and isolated final run passed those checks.
An intermediate full run failed only the existing candidate-provenance gate,
which required the new commit and artifact record now shown above.

## Verification under machine load

A subsequent pre-push run at file concurrency 12 hit a store-lock deadline in
`claude-native-delivery.test.mjs`. The unchanged scenario took over 13 seconds in
that run and passed alone in 0.56 seconds. The host exposed 18 CPUs and reported
load averages of approximately 25, 45, and 38 after the failed run.

The test runner now accepts `ACC_TEST_FILE_CONCURRENCY` to reduce file pressure.
The override cannot raise the existing platform ceiling. It does not change the
file list, test timeouts, fsync policy, or concurrency inside test cases. The new
guard failed with `12 !== 4` before implementation. All 10 runner tests then
passed, and discovery still selected 410 files with the override set to 4.
This test-only adjustment does not change the recorded package bytes.
