# Troubleshooting

Start with:

```bash
acc doctor
```

It reports detected clients, exact versions, installation ownership, capability downgrade,
and the next action. Restart a client after installation because hooks load at startup.

You should not need to tell an agent to use ACC as part of a normal task. If coordination
is not visible, first check integration and capability facts here. Remember that a working
integration provides awareness; it cannot guarantee that a model will find a peer relevant
or coordinate on every task.

## The second session does not appear

As a diagnostic, run `acc status --json` in both windows and compare `workspaceId`. Common causes are an
already-running client that never loaded the hook, a generic MCP server launched without
`ACC_MCP_WORKSPACE`, or two plain directories that are not the same workspace. Codex also
requires plugin trust.

ACC does not launch a missing session. Open it normally after fixing the installation or
workspace path.

## A hook says `workspace contains ACC runtime state`

The current directory contains ACC's own state, so ACC cannot use it as a workspace.
This commonly happens when a client starts in your home directory (`~`). The client
continues normally, but ACC provides no coordination context there.

Open a project directory and restart the client from it. A project inside your home
works normally; Git is optional. If you intentionally need the broader directory as
a workspace, configure `ACC_DATA_HOME` outside it for all participating clients.
This changes the state location; it does not migrate existing history or integrations.

For a generic `coordination unavailable` warning, run `acc status --json` from the
same directory to see the detailed workspace error, and `acc doctor` to check the
installation. Hook warnings deliberately omit arbitrary paths and error details.

## CLI says `caller_identity_unresolved`

ACC cannot prove which session owns this shell command. A hook-created presence record
and the client's native session ID are not shell credentials. Restarting hooks alone does
not fix this CLI limitation.

In Grok, run public `acc status --json` through the terminal tool first. With the
updated integration, the ACC hook reminder arrives after that result and supplies
the session's own CLI arguments. Restart Grok after refreshing its integration;
a header returned with `finish` belongs to the session that just closed.

Use this session's ACC MCP tools if available. For a manual CLI workflow, open your own
session with `acc attach --participant my-session --json`, retain the returned `sessionId`
and `generation`, and pass both as `--session` and `--generation` on subsequent mutations
and inbox reads. This creates separate manual presence; finish it with the same pair.
An operator may explicitly configure `ACC_SESSION` and `ACC_GENERATION` instead.
Neither a new manual session nor a generic MCP connection inherits the hook participant's
inbox. Pending messages must be handled through the identity they address; if that
identity is unavailable, report the limitation.

Do not copy another session from `status`, read its binding, or guess a generation. Public
`status` and `sync` still work. If ownership is unavailable, report the coordination
limitation and continue the user's actual work.

## A message stays queued

Queued means the durable message is safe; it does not mean the recipient model saw it. The
receiving agent can recover it with:

```bash
acc inbox
acc inbox --message message_x
```

Certified next-turn delivery waits for that client's next normal prompt; it never wakes an
idle session. Grok, generic MCP, unknown client versions, and other platforms poll inbox. A
reply acknowledges the original automatically; `acc ack` is for acknowledgement-only
messages.

A background inbox command is not evidence that the model will resume. If a reviewer
ends its turn or exits before the request arrives, the review is still incomplete. For
an agreed review in the current session, keep the turn active through bounded foreground
waits and inbox checks; if the wait must end, report the pending review and leave a partial
handoff. ACC does not restart an exited client.

## I enabled live delivery but got fallback

`--delivery actionable|all` records recipient intent; delivery also needs a
supported platform, current probe and exact session binding. Under `actionable`,
a `note` stays queued with `delivery_disabled`.

For Codex, use your ordinary launch command with 0.152.1 or newer on Apple Silicon
macOS. Its LocalDaemon must already be running, and trusted hooks must establish
the receiver's exact thread and workspace. Embedded sessions, an absent socket,
ambiguous recipients or failed identity checks retain durable inbox access.
`acc doctor` reports readiness, consent and the current workspace's live channel separately.
`native_endpoint_unavailable` means the local service endpoint is missing or is not a safe socket;
`native_session_unavailable` means the service answered but has no loaded thread to probe.
An interactive install can save consent in either case. ACC preserves it through a temporary
outage and does not start the daemon for you.

Check `acc doctor --json` and `acc status --json` while both clients are open. If policy is
`off`, opt in with `acc install --adapter codex --delivery actionable` (or select another
adapter). This can spend model tokens. If policy is enabled but runtime is `waiting` and
`deliveryBindings` is empty, no live channel is bound in this workspace. Start a new client
session, check its integration prompts and re-run doctor. A healthy store, online peers,
or a connected MCP server does not by itself establish automatic delivery. `lifecycle:
manual` can also mean the current version has no certified session-end hook; it does not
prove that no hooks ran.

For Claude Code, open a fresh interactive zsh after installation so its launcher
is on PATH, and accept its visible development-channel warning. A failed channel
connection may remain in Claude's `~/.claude/mcp-needs-auth-cache.json` for about
fifteen minutes; remove only the `acc` entry and restart if that is the cause.

Closing a Codex terminal can leave its daemon thread loaded and eligible. Use
`acc install --adapter codex --delivery off` to stop new ACC native offers.
Already accepted queue entries remain with the vendor. Actual thread archive
requires Codex's confirmation and produces `SessionEnd`.

## Codex plugin is listed but inactive

Open `/plugins` in Codex and check ACC is enabled. Open `/hooks`, review each ACC hook,
and enable/trust its current definition if needed; then restart the session. New or changed
definitions need review, and a trusted hook can still be disabled.

`acc doctor` reports installed files separately from hook readiness, which it leaves
unverified. A saved trust record cannot prove current activation. If installation preserved
your own sandbox configuration, doctor also names the ACC state directory whose access
you should check in `sandbox_workspace_write.writable_roots`.

## Gemini does not guard a write

Default and `plan` modes expose no write tool to the model. `auto_edit` exposes edit tools;
shell availability depends on approval mode. Only Gemini CLI 0.57.0 on `darwin-arm64` has
package-shipped delivery certification; other versions still use inbox.

From 0.55 onwards there is a quieter cause with the same symptom: an untrusted folder. The
client prints `Approval mode overridden to "default" because the current folder is not
trusted` and keeps going, and the default mode has no write or shell tool to guard - so the
guard never fires and the mode you passed appears to have been ignored. Trust the folder,
or start the session somewhere trusted.

## Grok shows no injected message

Grok discards UserPromptSubmit context. On the observed 1.0.24 client, run public
`acc status --json` in its terminal first: the ACC hook reminder after the result
supplies your own `--session` and `--generation` pair for subsequent inbox reads and
mutations. Restart Grok after refreshing its installed hooks and skill. Its next-turn,
live delivery, and guard capabilities remain false; peer messages require explicit inbox
reads. If the header never arrives, report missing ownership rather than adopting a peer.

## Kimi sessions remain in history

Kimi 0.36.1 emits a heartbeat but prompt-mode `SessionEnd` was not observed. An exited
session becomes offline by presence rules rather than a clean end signal. The default
status hides offline sessions; `acc status --all` intentionally retains attribution and
checkout history.

## A write was blocked

Exit code `5` names the overlapping claim and owner. Ask the owner or wait for release. If
an explicit authority has decided to replace it:

```bash
acc release --claim claim_x --authority human \
  --reason "human approved the handover after agreement with the models"
```

## Protection says advisory

At least one live participant cannot be stopped through a certified hook, or at least one
claim asked only for advisory enforcement. This includes generic MCP and Grok. Respect the
claim manually; `guarded` would be a false room-wide promise.

## Store version is incompatible

v0.2 rejects v0.1 state and provides no migration or automatic deletion. `acc doctor`
identifies the incompatible data path. Back it up or remove it deliberately only after
confirming no needed coordination state remains.

## Uninstall left files

ACC removes only bytes that still match its install record. Anything edited by the user is
reported and retained. Remove those leftovers manually if desired.

Runtime state is outside the repository by design. `ACC_DATA_HOME` can relocate it, but ACC
refuses a path inside any workspace root. Relocate the whole data directory; a symlink for
that directory is supported. Install rejects a symlink that moves only the internal
`acc/runtime` tree, because runtime admission and the bootstrap cache need the same data home.

Next: [Getting started](GETTING_STARTED.md) · [Capabilities](CAPABILITIES.md) ·
[Configuration](CONFIGURATION.md)

## An automatic update is pending

Run `acc doctor` to see the update policy and pending notice. ACC process leases, including
persistent MCP servers, require confirmed process exit. Native bindings clear on observed
SessionEnd or confirmed process death; a vendor daemon may remain alive after SessionEnd.
Unknown PIDs remain holds until lifecycle cleanup. Close the relevant client sessions and
ACC processes; `finish`, presence TTL, and delivery off do not prove native end. ACC never
manages the daemon or expires safety holds merely by elapsed time.

Use `acc update` to retry a failed download or finish an interrupted integration refresh.
A download failure keeps the working version. A partial integration refresh blocks
workspace commands until recovery completes, while hooks let the client continue without
ACC context. `acc update` names the failed adapter, cause, and known configuration paths;
fix that problem and rerun it. Help and update recovery remain available. `ACC_NO_UPDATE_CHECK=1` prevents
new downloads but permits manual activation of an already verified pending update.

To stop automatic downloads, use `acc update --auto off`. To stay on the current release,
use `acc update --pin <version>`. Neither setting converts workspace data for an older
runtime. See the [upgrade guide](UPGRADING.md).
