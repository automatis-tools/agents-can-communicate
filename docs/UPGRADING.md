# Upgrading to 0.5.0

## From 0.4.4, 0.4.3, 0.4.2, 0.4.1 or 0.4.0

This release keeps the existing workspace data format. It changes when an update is
allowed to take effect: activation is gated on the store contract a running process
declares rather than on which version it happens to be, sessions finish on the generation
they started with, unreferenced generation directories are reclaimed, and `acc uninstall`
retires the holds its own install published. It carries the previous 0.4.x confirmed
service maintenance, outgoing sandbox permissions, delivery diagnostics, session recovery
and integration fixes.

```bash
acc update
acc version
acc doctor
```

After publication, `acc version` should report 0.5.0. If a pin keeps an older version,
select 0.5.0 or clear it first. A managed update refreshes installed integrations and
skills; use the npm instructions below for unmanaged or pre-0.4 installations. Start
clients again and complete any hook/trust review they request. With existing live consent,
Codex 0.153.4 or newer on macOS arm64 receives local socket permissions when its workspace
policy is default or contains only ACC's legacy state root. Custom policies are preserved
and reported as unverified. See [outgoing permissions](CONFIGURATION.md#codex-outgoing-permissions).
If doctor names a missing local service, run `codex app-server daemon start` before opening
the new session.

Run `acc doctor` in the project after the new clients have started (or submitted a normal
turn). Its per-session lines now explain missing launch consent, an unidentified client
process and a failed or timed-out handshake. `nativeDelivery.sessions[].lastAttempt` in
`acc doctor --json` provides the same closed metadata and timestamp. Existing owners may
have no attempt record until a new hook runs; missing metadata does not prove hooks are
disabled. A previous successful handshake and a connected MCP server do not prove that
Claude admitted inbound Channels messages. See [delivery troubleshooting](TROUBLESHOOTING.md#i-enabled-live-delivery-but-got-fallback).

Upgrading preserves delivery consent. If doctor reports native delivery off and you want
automatic peer requests, use `acc install --adapter codex --delivery actionable` (or the
relevant adapter); this can spend model tokens. Codex can save that consent before its
local service/session becomes available. Installation does not start the vendor daemon; ACC
keeps durable inbox access when no verified live channel is bound.

In Grok, public status supplies the session's own CLI arguments through the next tool
hook. Grok still uses explicit inbox reads; this patch adds no external wake or guards.
Start clients in a project directory, rather than a home directory containing ACC state.

## What still waits for a process to exit, and what no longer does

Earlier releases held a verified update until every live ACC process and every native
client binding was gone. Each of those holds now states the store contract it speaks, and
only two kinds keep an update pending:

- A hold whose declared store contract differs from the incoming version's. This is the
  case the gate exists for, and a release that changes the store contract still needs
  every live process to exit.
- A hold that declares no contract, which includes every record written by a release
  before this one. Unknown cannot be compared, so it stays a conservative wait.

A hold declaring the same store contract as the incoming version proceeds. Several open
Claude Code sessions, a Codex daemon and an idle ACC MCP server no longer have to be
closed together to move between releases that share a contract.

The first update after installing this release still waits for every process, because the
holds it has to judge were written before the contract field existed. Close the relevant
clients and persistent ACC processes once, or accept the eligible Codex service
maintenance offer described below. Updates after that do not need it.

`acc update` names each remaining hold with its process and its declared contract, so a
wait now states its reason rather than only the PID. `acc doctor` reports the same
pending notice.

A session that is open while an activation completes keeps running the generation it
started with, including its hooks, until it ends; it does not get half of one version and
half of another. A session whose pin names a generation with a different store contract
runs the active generation instead, which is the same behaviour as having no pin.

A restart offer for a client's background service is now made only when the version that
service is actually running fails that client's captured contract, or when it still holds
a native binding. A Codex CLI that updated while its daemon kept serving the previous
build is an ordinary state, and it no longer produces a prompt to disconnect open clients.

Generation directories that nothing references are removed after an activation instead of
accumulating. A directory is kept while any control pointer, live runtime lease, live
session pin or in-flight staging hold names it, and an unreadable holder postpones the
whole sweep rather than being assumed dead.

`acc uninstall` retires the binding records and session pins its own install published,
so they stop holding a later activation, when the removal leaves no client installed. It
never signals or terminates a client process. Removing one client while another stays
installed retires nothing, because a binding record names the generation that published
it and no client id. Runtime leases are left in place on purpose: a lease is also what
protects the generation a running process is executing from, and clearing it would let
that directory be reclaimed out from under the process. A live ACC process therefore
keeps holding activation across an uninstall until it exits.

## Confirmed client service maintenance

On macOS arm64, `acc update` can ask once to restart a verified Codex service that holds a
native binding blocking activation, or that is serving a version outside the captured
native-delivery contract. A serving version that satisfies that contract is left alone,
even when the installed CLI has moved to a newer build. The captured maintenance contract
uses Codex CLI 0.154.0 and its `pid` backend, with compatible commands and protocol
checked again at runtime. The installed CLI and managed executable must already match;
ACC does not replace vendor binaries or install an operating-system service.

After confirmation, a detached ACC worker waits up to 15 minutes for idle Codex turns,
empty queues, the requesting command to exit, and any other ACC process still holding the
update. It judges those holds by the same contract rule the activation path uses, so a
process declaring the incoming version's store contract does not delay the restart, and
one declaring a differing or unknown contract does. It rechecks the approved candidate, settings,
PID/start time, executable, socket ownership and versions before stopping the service.
It refreshes integrations, starts the service again and verifies the result. If refreshing
integrations fails, it still restores the service and reports the incomplete update.
A later update worker can resume an already approved recovery without another question.
`acc doctor --json` exposes `update.maintenance`; ordinary `acc doctor` describes its state.
A current launcher can use the newer management reader while the old runtime is active.
When admission is blocked, doctor returns an update-only report without inspecting the
workspace or repairing it. Older launchers gain this reader after activation, or through
the one-time launcher bootstrap described below.

Open clients disconnect. Resume them afterward and complete any client-owned hook trust
review. Codex has no atomic idle-check-and-stop operation: a new turn arriving during the
final check can be interrupted. ACC does not promise that client UIs reconnect themselves
or that an interrupted turn continues automatically. Unknown ownership, incompatible
service layouts and unrelated active processes remain visible blockers.

For an unattended command, `acc update --yes` explicitly consents to the same restart.
`acc update --check` stays read-only. Background discovery never grants restart consent.
Changing the candidate or pin before the stop cancels that approval; idle-wait expiration
also leaves the service untouched. Delivery consent and automatic-update opt-outs survive
an update even when a native service or feature probe is temporarily unavailable.

An old installation can already be stuck with both a pre-0.4.4 pending runtime and the
old updater that waits indefinitely. That code cannot discover this fix. Bootstrap the
new launcher once with `npm install --global agents-can-communicate@0.5.0`, then run
`acc update`. The new launcher stages its verified runtime and retires only an exactly
identified obsolete ACC background updater while no integrations are being written.
This does not terminate an unrelated client or bypass its lifetime hold.

## From 0.3.1

Upgrade all ACC installations participating in a workspace together, then restart their
agent clients. The new runtime reads existing 0.3.1 messages, receipts, decisions, intent,
and claims. Installing it does not migrate or clear that history.

Mixed running versions are unsupported. Once a new session records an explicit decision
replacement or withdrawal, the published 0.3.1 reader rejects its `decisionChange` field.
Its doctor can label the valid new record as corrupt. Upgrading the remaining reader
restores access; deleting or editing the record is not a remedy.

## Update the runtime and client integrations

1. Finish or pause ongoing work and close the participating clients, including persistent
   ACC MCP processes. A running process can retain the old code after npm replaces its files.
   If rollback matters, take a copy of the complete ACC data directory and client settings
   while those processes are stopped. Keep the copy outside the repository; see
   [runtime locations](CONFIGURATION.md#override-local-paths-and-identity).
2. Install the released package, then refresh the client integrations:

   ```bash
   npm install --global agents-can-communicate@0.5.0
   acc version
   acc install
   ```

   Before publication, use the exact candidate `.tgz` supplied for testing instead of the
   registry version. `acc version` must report the intended version. If it does not, fix
   which `acc` your shell resolves before running the installer.
3. Run `acc doctor` from each project you use. Check the runtime and installed bundle
   diagnostics, and follow any activation instructions from `acc install`. In Codex,
   check `/plugins`, review and enable/trust the current ACC definitions in `/hooks`, then
   restart the session. Doctor cannot establish that the client has activated its hooks.
   In the observed stock Codex 0.153.4 upgrade from 0.3.1 to 0.4, command quoting changed
   all five ACC hook definitions and required a fresh review of the modified hooks. After
   that review, a subsequent restart retained all five active. This is activation evidence
   for that transition, not a promise of trust across arbitrary future upgrades.
4. Resume the intended conversations and confirm peer presence with `acc status`. An
   unrelated new conversation normally has a new participant id; it does not inherit the
   previous conversation's addressed inbox. Historical decisions and handoffs remain
   available through [history reads](CLI.md#historical-recovery).

`npm install` alone updates the package but does not refresh the skills and plugin copies
inside clients. `acc install` preserves user settings and the recorded delivery policy;
it does not turn experimental delivery on for a previously opted-out client. Effective
delivery still depends on the current client's capabilities.

## Automatic updates after installation

An initial `acc install` turns automatic updates on. Later installs preserve an explicit
`acc update --auto off` choice. Full uninstall pauses updates and preserves the setting
for the next install. ACC checks for stable releases in
an independent background process, normally at most once a day, downloads and verifies a
separate runtime copy, and refreshes the installed integrations and skills before switching.
The global npm package provides a launcher; the active runtime lives under ACC's data home.

Running ACC processes, including idle MCP servers, still publish a hold for as long as they
live, and native bindings still hold until observed client SessionEnd cleanup or confirmed
process death; the vendor daemon can remain running after that lifecycle event. What
changed is which of those holds keeps an update pending: only one whose declared store
contract differs from the incoming version's, or that declares none at all. Unknown PIDs
remain conservative holds until lifecycle cleanup. `acc finish`, presence TTL, and delivery
off alone still do not prove native end. When a hold does block, close the relevant client
sessions and persistent ACC processes to release it, or accept the eligible Codex service
maintenance offer in `acc update`. Background updates never request fresh restart consent.
Hooks never wait for a network download. If integration refresh temporarily prevents
coordination, a hook lets the client continue; its next genuine user turn can restore a
missing binding.

```bash
acc update                    # download and apply, or report what is keeping it pending
acc update --check            # check without installing or changing update settings
acc update --auto off         # disable background updates
acc update --auto on          # enable them again
acc update --pin 0.5.0        # stay on this exact stable version
acc update --pin none         # follow stable releases again
```

ACC 0.4.0 lost the previous update setting during a full uninstall. If you already ran
that version's `uninstall` and want updates enabled after reinstalling, run
`acc update --auto on` once. A later installer cannot distinguish that old uninstall
state from an explicit opt-out, so it keeps the recorded `off` value until you change it.

`--apply` remains an alias for the plain update command. Pins cannot downgrade an active
runtime. `ACC_NO_UPDATE_CHECK=1` disables update networking and background scheduling;
manual recovery of an already downloaded update still works. Downloading needs npm, but
does not require permission to replace a global installation and never runs package
lifecycle scripts. `acc doctor` reports the automatic-update policy and pending notice.

A failed download or verification keeps the active runtime. An interrupted integration
refresh keeps workspace admission closed until `acc update` finishes the refresh. It does
not roll workspace history back. A failed refresh exits with code `4` and reports the adapter
and configuration problem to fix before retrying; a verified update waiting for a blocking
hold remains pending. A previous runtime version is retained for as long as anything can
still reach it — a control pointer, a live ACC process, or an open session pinned to it —
so existing launch paths survive the change; once nothing references it, its directory is
reclaimed after the next activation instead of accumulating.

Client trust is still controlled by the client. Follow any reported activation or hook
review steps; copied files do not prove the client has activated them. The initial
published-0.3.1 transition above still requires a coordinated restart: old direct binaries
and existing embedded core consumers cannot be enrolled retroactively.

## Update scripts and MCP consumers

Default CLI/MCP inbox reads and `acc://inbox` now return `{items, nextCursor}` summary
pages. They omit bodies and do not mark messages retrieved. Code that expected a full
array must list a page, select a message id, then make an exact inbox read to retrieve its
body. Follow `nextCursor` until it is `null` when inspecting the whole pending inbox.
Exact inbox reads retain the one-item full-message array and receipt transitions.
See [CLI inbox](CLI.md#inbox-reply-and-acknowledgement) and [MCP](MCP.md).

New decision links remove superseded records from ordinary inbox and automatic attention,
while retaining their bodies and original receipts in history. A terminal withdrawal
remains visible. These changes do not acknowledge old obligations on the recipient's
behalf. Use `acc sync --scope history --type decision --current` to discover the current
explicit choices, withdrawals, and conflicts.

## Recovery and rollback

An old reader reporting `message.decisionChange is not a known field`, or old doctor
reporting an unreadable record immediately after a decision change, needs the new runtime.
Run the new `acc version`, refresh integrations, restart clients, and use the new
`acc doctor`. If that doctor still reports a fault, inspect its named paths as a separate
problem. Do not erase history or use an old repair command to resolve version mismatch.

There is no downgrade conversion for new decision records. Reinstalling 0.3.1, including
using `acc install --downgrade`, does not make them readable by old clients. A rollback
that restores a pre-upgrade data copy necessarily omits subsequent coordination records;
retain the newer copy separately. Prefer completing the upgrade so all history remains
available.
