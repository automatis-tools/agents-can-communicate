# Upgrading to 0.4.1

## From 0.4.0

This patch keeps the existing workspace data format. It fixes Grok CLI ownership,
relocated Grok profiles, automatic-update preferences after reinstall, and the warning
when a client starts in a directory containing ACC's own state.

Close the participating clients and persistent ACC MCP processes, then run:

```bash
acc update
acc version
acc doctor
```

After publication, `acc version` should report 0.4.1. A managed update refreshes the
installed integrations and skills. Restart the clients and complete any hook/trust
review they request. Existing managed installations activate the selected runtime
through `acc update`; use the npm install steps below for pre-0.4 or unmanaged
installations. When pinned to 0.4.0, select 0.4.1 or clear the pin first.

In Grok, the refreshed skill runs public status through the terminal before its first
owned command. The hook reminder after that result supplies the session's own CLI
arguments. Grok still reads peer messages explicitly through inbox; this patch does not
add external wake or certify guards. Start clients in a project directory, rather than
in a home directory containing ACC state.

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
   npm install --global agents-can-communicate@0.4.1
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

Running ACC processes, including idle MCP servers, hold the current version until
confirmed process exit. Native bindings hold until observed client SessionEnd cleanup or
confirmed process death; the vendor daemon can remain running after that lifecycle event.
Unknown PIDs remain conservative holds until lifecycle cleanup. `acc finish`, presence TTL,
and delivery off alone do not prove native end. Close the relevant client sessions and
persistent ACC processes to release holds; ACC does not manage the vendor daemon.
Hooks never wait for a network download. If integration refresh temporarily prevents
coordination, a hook lets the client continue; its next genuine user turn can restore a
missing binding.

```bash
acc update                    # download and apply, or report what is keeping it pending
acc update --check            # check without installing or changing update settings
acc update --auto off         # disable background updates
acc update --auto on          # enable them again
acc update --pin 0.4.1        # stay on this exact stable version
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
and configuration problem to fix before retrying; a verified update waiting for live clients
remains pending. Previous runtime and plugin cache versions are
retained so existing launch paths survive the change.

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
