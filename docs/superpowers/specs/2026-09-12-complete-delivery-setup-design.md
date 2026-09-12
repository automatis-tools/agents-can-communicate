# Complete delivery setup

## Problem and observed behavior

ACC 0.5.3 already asks for live-delivery consent for Claude Code and Codex CLI.
`decideDelivery` asks once per eligible client. A captured packed install with
answers yes/yes records actionable/actionable; yes/no records actionable/off.
An absent Codex service does not by itself change an affirmative answer to off.
The supplied user report cannot establish which answer or installation path
produced off because the ownership record does not retain the decision source.

Codex activation only reuses an existing service. Its plan has no start command.
The installer can save consent and permissions while leaving the missing service
as a manual instruction. Claude already has an owned shell bootstrap and Channels
setup; an MCP connection alone does not establish inbound delivery.

## Chosen approach

Extend the existing install pipeline. One default-No choice covers all selected
clients that need a decision. It names those clients, discloses automatic token
use, local permission configuration, Claude Channels startup requirements, and
starting a missing supported Codex service. No extra wizard or coordinator is
introduced. `--delivery actionable` and `--delivery all` are explicit consent to
the same complete setup. `--delivery off`, dry runs, and noninteractive defaults
do not start services.

Keep a recorded non-off policy. A legacy opt-in without consent to service setup
can be asked once during an interactive install if its service needs preparation.
Declining that expanded setup preserves the old opt-in and does not start a
service. An affirmative decision records complete-setup consent. Automatic
updates retain the record but never acquire consent or cold-start a service.

## Durable decision facts

Keep `deliveryPolicy` and add optional `deliveryDecision` to the ownership entry:

```js
{ source: "interactive-accepted", completeSetup: true }
```

Sources are `interactive-accepted`, `interactive-declined`, `explicit-option`,
`noninteractive-default`, `unsupported-default`, and `legacy-unknown`. Old entries
remain readable. Retaining a policy also retains its known source. Dry-run output
describes a preview and never persists a decision. A declined expansion of a
legacy non-off decision keeps its original source and completeSetup false.

`doctor` reports the known origin of off. It says unknown for legacy records;
it does not infer a decline from off. Outgoing permission warnings appear once
and distinguish absent ACC grants from preserved custom settings. Already owned
outgoing permission grants survive disabling incoming automatic requests; an
off-only fresh install creates no new grants. Uninstall still restores owned
permission changes, and modified/custom policy remains untouched.

## Service preparation boundary

Add optional adapter ports `inspectNativeServiceSetup(context)` and
`prepareNativeServiceSetup({ context, plan })`. Only explicit install apply calls
the latter, after adapter configuration succeeds and installation ownership and
consent are recorded. Detection, planning, doctor, hooks, routing, and automatic
refresh stay read-only with respect to service lifecycle.

Inspection returns a structured plan with `state` equal to `ready`, `needed`,
`blocked`, or `unsupported`, plus a safe reason and diagnostic. A needed plan pins
the home, Codex home, CLI and managed executable identity, version, and service
paths. The operation is included in dry-run output. Application rechecks the
plan, starts only a definitely absent service, and verifies the actual service
and native protocol before reporting ready. An existing healthy service is a
no-op. An unsafe/stale socket or PID is blocked; ACC does not delete it or restart
an existing process as part of cold setup. A raced healthy service is reused.

Codex-specific commands and identity checks stay in adapter-codex. Reuse the
maintenance host helpers where their contracts apply; cold start has no old PID
to approve and must not pretend to be a maintenance restart. The supported first
implementation uses the captured darwin-arm64 PID backend, Codex >=0.154.0, and
matching existing CLI and managed standalone versions. The installer executes
the pinned CLI with the pinned HOME and CODEX_HOME and a bounded timeout.

A real CLI capture in a fresh CODEX_HOME shows daemon start fails without the
managed standalone installation. ACC will diagnose this prerequisite and provide
the vendor installation action; it will not silently download or copy Codex.
No reboot persistence, new hook capability, or completed message delivery is
claimed by a successful service start. A new client session may still be needed
to load permissions, trust hooks, and establish its own delivery binding.

An attempted start or verification failure is visible and returns failure while
preserving the installed adapter and consent for retry. Other adapters finish.
An unsupported or missing prerequisite is an explicit needs-action outcome, not
a claim that setup is ready. Uninstall does not stop the shared vendor daemon.

## Alternatives considered

Keeping independent prompts and adding another daemon prompt leaves the consent
flow fragmented. Starting services from doctor/hooks would make diagnostics and
ordinary sessions mutate lifecycle state and would hide failures. A new global
onboarding state machine duplicates the current detect/plan/apply/ownership
pipeline. The selected approach adds decision facts and one adapter operation.

## Verification and release scope

Use focused red/green tests and exact mutations for regression gates. Exercise
the packed CLI in private homes with one two-client confirmation, an absent
service, refused permission changes, dry run, retry, and automatic refresh.
Capture a real supported cold start in a disposable managed-install fixture,
separately identify fixture preparation, and preserve historical evidence.
Run all AGENTS.md gates on the final branch. No release, push, or merge is part
of this change. Remaining client-owned trust prompts stay explicit in output.
