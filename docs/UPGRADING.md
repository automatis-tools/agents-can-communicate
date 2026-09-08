# Upgrading from 0.3.1 to 0.4

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
   npm install --global agents-can-communicate@0.4.0
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
4. Resume the intended conversations and confirm peer presence with `acc status`. An
   unrelated new conversation normally has a new participant id; it does not inherit the
   previous conversation's addressed inbox. Historical decisions and handoffs remain
   available through [history reads](CLI.md#historical-recovery).

`npm install` alone updates the package but does not refresh the skills and plugin copies
inside clients. `acc install` preserves user settings and the recorded delivery policy;
it does not turn experimental delivery on for a previously opted-out client. Effective
delivery still depends on the current client's capabilities.

When a newer version is available, the new `acc update --apply` runs both installation
steps, reports a failed step with exit code `4`, and names the commands still needed.
Successful application includes the installer's
activation instructions and a restart reminder. Published 0.3.1 can return exit code `0`
despite a failed step, so use the explicit commands above for this transition. If npm
succeeds but refreshing integrations fails, fix that error and rerun `acc install`;
checking for a newer package again does not finish that step.

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
