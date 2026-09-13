# Complete delivery setup — development validation

This record describes the unpublished `feat/complete-delivery-setup` branch. The
manifest remains 0.5.3. It does not replace the published or candidate 0.5.3 record.

## Behavior and review scope

The existing install confirmation now covers all selected clients needing a
choice. Ownership stores its source and whether complete setup was approved.
Explicit install can prepare a missing supported Codex service after that choice;
doctor, hooks, automatic refresh, dry run, and refusal cannot start it. Already
owned outgoing permission grants survive disabling incoming requests.

The source report alone cannot explain why the external user's Codex policy was
off: older ownership records did not store its origin. Missing service readiness
and saved off policy were independent facts. Current diagnostics preserve that
distinction and distinguish absent grants from custom permissions.

## Mutation and behavioral failure evidence

Every mutation below was restored before green verification. The initial socket
EPERM from restricted execution is not counted as behavioral failure evidence.

| Regression introduced | Observed failure |
|---|---|
| Remove delivery-decision persistence in installer apply | Ownership round-trip lost the saved source and complete-setup choice |
| Accept incoherent source/policy/completeSetup combinations | Decision tests incorrectly granted complete setup |
| Omit native protocol verification | Two service tests detected missing metadata requests and false readiness |
| Omit explicit-install gate | Automatic refresh included service preparation |
| Omit complete-consent gate | Incomplete consent included service preparation |
| Omit cold-start command | Definite absence did not become verified infrastructure readiness |
| Omit loaded-thread metadata validation | Six regressions accepted malformed metadata as a ready service |
| Remove owned-grant retention | Disabling incoming delivery removed the approved default permission profile |
| Add another shipped CLI confirmation | Packed install observed two prompts instead of one |
| Remove dry-run apply guard | Packed command log contained a daemon start during preview |
| Invert terminal refusal | Packed No case saved actionable consent and attempted daemon start |
| Replace cold start with a successful no-op | Maintained packed success failed with daemon_socket_unproven |
| Label a missing managed prerequisite ready | Structured packed assertion received ready instead of blocked |
| Prevent recognition of the terminal prompt | The harness killed the child at its deadline and reported captured output |

Focused test commands used `node --test` on the changed CLI, installer, Codex,
packed onboarding, and process tests. Task 1's review fix passed 53 tests with one
existing Gemini skip. Task 2 passed 323 tests with that skip; its protocol-validation
fix passed 55 covering tests. Task 3's initial final focused run passed 79 tests.
The review fix passed 12 affected tests, including maintained packed successful
preparation using the shared protocol fixture and real PID, ps, lsof, and socket
checks. Its generated launcher escape error was a harness failure and is excluded
from behavioral proof. The complete gate results below supersede those scoped counts.

## Actual installed artifact

[Compatibility observations](../../../packages/adapter-codex/COMPATIBILITY.md) and
the [closed capture fixture](../../../packages/adapter-codex/fixtures/setup/acc-development-complete-delivery-setup.json)
record an actual packed development build at `b0b9759730f3adbe7c482fe3b7a844b2453e95ff`.
Archive SHA-256: `006cb5750bfe014c6f8a7ea363b204582a619c887a291802950496c035c04aef`.

A private HOME/CODEX_HOME used a fixture-only symlink to installed Codex 0.154.0
on darwin-arm64. Dry run created no service. Explicit installation started and
verified it; repeated installation and incoming-off retained the same PID/start
time identity. Off retained owned outgoing grants. Uninstall removed those grants
and retained the vendor daemon. Fixture cleanup stopped its exact process and
verified that PID/socket metadata and the fixture root were gone.

The managed standalone installation is a prerequisite; ACC does not download it.
An empty verified service is infrastructure-ready and still has no recipient
session. No model, message delivery, active sandbox access, client trust, login,
or reboot behavior was asserted by this capture. Existing capability claims remain
bounded by their separate client evidence.

## Full gates

Verified source: `78cb9914a8c1ea5e0c7e35991bfcf1373c66dd37`, on macOS arm64 with
Node 26.5.1. Final syntax, full-suite, and package gates ran on the committed source.

| Gate | Result |
|---|---|
| `npm ci` | Passed; 14 workspace packages installed |
| `npm run check` | Passed; 533 tracked JavaScript modules checked |
| `npm test` | Passed; 2,204 tests, 2,203 passes, zero failures, one existing skip; 416.97 seconds |
| `npm pack` | Passed; 391,998 bytes, 275 files |
| `node scripts/verify-package.mjs` | Passed; same archive SHA-256 as the actual Codex capture |

The skipped test requires Gemini CLI to be absent; Gemini is installed on this
machine. It is an existing environment-dependent skip. The package verifier
exercised installation, a Git-free workspace, exact configuration restoration,
and repeat uninstall. The final whole-branch review covered `479c7d5..78cb991`
and reported no Critical, Important, or Minor findings. Its pending full-suite
condition was satisfied by the result above.

The first and final gate logs remain separately recorded under
`/private/tmp/acc-final-*.log` and `/private/tmp/acc-final-2-*.log`. No release,
push, or merge was performed. Later evidence-only changes do not alter the packed
artifact; the historical release records remain unchanged.

The first full run used controller-supplied `npm_config_offline=true`. Nine
update-fixture tests failed with ENOTCACHED because their private localhost npm
registry needed access. A focused repeat with offline disabled passed. Subsequent
full validation used `npm_config_offline=false`, a private npm cache, no audit/fund,
and `ACC_NO_UPDATE_CHECK=1`. Two further initial failures identified the stale
doctor assertion and the need for a new Unreleased artifact record; both were
resolved without rewriting historical release evidence.

## PR 127 macOS CI follow-up

CI run `34728972060` failed two tests on macOS with Node 24.20.0.
The Linux suite, both package jobs, and lint passed.

The packed service fixture placed its socket under the runner's long `TMPDIR`.
That path exceeded the macOS Unix socket limit. The original test reproduced
`daemon_start_failed` with a deliberately long local `TMPDIR`. A separate
150-byte socket bind returned `EINVAL`. The corrected fixture uses a short,
unique, canonical Codex home and checks the socket path length before launch.
It removes that home after stopping its daemon. The packed installation still
uses the ambient temporary directory.

The PTY test assumed that its child exited within 150 milliseconds. A controlled
child reproduced the same missing-rejection failure while its observed exit was
still `null`. The corrected test holds the child until it verifies the live case.
It then releases the child and observes both its output and exit before checking
the specific rejection. The production harness is unchanged.

| Mutation in a private copy | Observed failure |
|---|---|
| Restore the nested Codex home under a long `TMPDIR` | Socket path length assertion failed |
| Reject argument text before the child exits | Live-child assertion received the argument rejection |
| Remove the argument-error classification | Final assertion received a generic exit error |

Local macOS validation used Node 24.4.0. Both affected test files passed all
14 tests. The packed test also passed with the long `TMPDIR`. Dependency
installation, syntax checks, packing, and package verification passed. The
archive SHA-256 remains `006cb5750bfe014c6f8a7ea363b204582a619c887a291802950496c035c04aef`.
Logs and the detailed PTY report are under `/private/tmp/acc-pr127-*`.
