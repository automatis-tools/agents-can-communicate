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

Native sessions launched from the same parent directory keep that room when their
agents enter different subdirectories or nested repositories. Hooks retain the launch
directory across compaction and native conversation resume. Use the hook header's
complete arguments, including `--cwd` and `--workspace`, after a shell changes directory.
The `acc://` workspace reference selects the saved room even if Git discovery changes.

Separate sessions launched directly in different repositories still select different
initial rooms; a repository and its own worktrees share one. To give those separate
launches a common room, use an explicit workspace configuration or `ACC_WORKSPACE_ROOT`
at startup. This does not merge histories or move messages between participant IDs.
Existing sessions from an older integration have no saved launch directory: their next
startup or user-turn hook establishes it. Return such a session to its original
directory before that hook, or start a fresh native conversation there.

## The owner arguments disappeared after compaction

Claude Code's `SessionStart` restores the original session's owner header after
compaction. Use its complete `--session`, `--generation`, `--cwd`, and `--workspace` arguments.
The hook retains the generation outside the model context; compaction does not require
manual attachment or a new participant. An older installed integration may need updating.

If the header is unavailable, use this session's ACC MCP tools when they own the
addressed participant, or report the limitation and continue the user's work. Do not
create a replacement participant just to recover context: it cannot inherit another
participant's inbox. `caller_workspace_mismatch` means the named session is absent from
the selected workspace; check the original directory before concluding there are no peers.

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
macOS. Its LocalDaemon infrastructure and trusted hooks must establish
the receiver's exact thread and workspace. Embedded sessions, an absent socket,
ambiguous recipients or failed identity checks retain durable inbox access.
`acc doctor` reports readiness, consent and the current workspace's live channel separately.
`native_endpoint_unavailable` means the local service endpoint is missing or is not a safe socket;
`native_session_unavailable` means the service answered but has no loaded thread to probe.
An interactive install can save consent in either case. ACC preserves it through a temporary
outage. On Codex 0.154.0 through 0.157.0, an explicit install can download the missing official
standalone package and prepare a missing service. Codex 0.157.1 and newer install the
service's own package at its first start, and an explicit install only starts it. The single setup choice covers the
download. Older consent for service start receives one expanded choice. To change a saved
download refusal, run `acc install --adapter codex --delivery actionable` (or `all` to retain
that policy). ACC preserves an existing npm or Homebrew command and shell profiles.
An unsafe or incomplete existing installation still requires the vendor action named by
doctor. Download failure keeps the installed integration and its inbox fallback. A ready
service is infrastructure only. Open a new Codex session afterward and complete the
client-owned hook and trust review.

After a reboot no Codex service runs. Codex 0.157.1 and newer start it when the next Codex
session opens (`daemon_auto_start`), and doctor then says so instead of advising `acc install`.
A Codex chat that started without the service runs on its own embedded service until it closes,
and no peer can reach it live. ACC reports it as `client_session_embedded`: the chat shows the
user a notice once, a sender sees the cause beside `no live transport`, and doctor names it on
the session line. Open a new Codex chat while the service runs; start it with
`codex app-server daemon start` if Codex does not.

The Codex app (inside ChatGPT.app) runs every chat this way: each window has its own app server
and never uses the shared one (openai/codex#41014, read on 26.928). Its chats join ACC through
the same hooks and get messages at their next turn; a chat started in a terminal is the one a
peer can reach live.

Some launch options make Codex run a chat embedded even while the service runs: `-c`/`--config`,
`--enable`, `--disable`, `--search`, `-p`/`--profile`, `--oss`, `--strict-config`,
`--dangerously-bypass-hook-trust` and `--no-daemon`, and also the `CODEX_EXEC_SERVER_URL`
environment variable. ACC names the option in the notice, the sender's line and doctor. For live
delivery, start Codex without it; put a setting you need in `config.toml` instead of `-c`,
`--enable`, `--disable`, `--search` or `--profile`.

If a reply stays queued with `transport_permission_denied`, the sender's permissions
blocked local transport. This is distinct from an unavailable recipient. The message was
recorded successfully; the error does not mean it was read or acknowledged.
On Codex 0.153.4 or newer, rerun `acc install --adapter codex` with existing
live consent. Add `--delivery actionable` when new consent is required, then start a new session.
With ACC 0.8.0 or 0.8.1, every live offer from a Codex session to Claude Code failed this way:
the Codex profile did not allow Claude Code's inbox directories, and doctor still reported it
configured. Doctor now names the missing paths. `acc install --adapter codex` or `acc update`
rewrites the profile; start a new Codex session so it runs under the new one.
A Claude Code session started with its own `CLAUDE_CODE_TMPDIR` or `XDG_RUNTIME_DIR` binds its
inbox outside the directories your shell's environment implies. After ACC first binds that
session, doctor names its directory. Run `acc install --adapter codex` again, then start a new
Codex session.
Doctor's `outgoingDelivery` reports the installed permission configuration separately
from `nativeDelivery.runtime`: an active receiving channel does not establish outgoing
access. Custom policies and active-session overrides remain unverified; inspect the config
path doctor names and follow [outgoing permissions](CONFIGURATION.md#codex-outgoing-permissions).

Check `acc doctor --json` and `acc status --json` while both clients are open. If policy is
`off`, opt in with `acc install --adapter codex --delivery actionable` (or select another
adapter). This can spend model tokens. If policy is enabled but runtime is `waiting` and
`deliveryBindings` is empty, no live channel is bound in this workspace. Start a new client
session, check its integration prompts and re-run doctor. A healthy store, online peers,
or a connected MCP server does not by itself establish automatic delivery. `lifecycle:
manual` can also mean the current version has no certified session-end hook; it does not
prove that no hooks ran.

For Claude Code, use version 2.1.282 or newer on Apple Silicon macOS, and start it with
your ordinary command. Each Claude Code session opens its own inbox socket. ACC reads the
socket path from `CLAUDE_CODE_MESSAGING_SOCKET` in the hook environment. ACC then checks that
path against Claude Code's session registry `<config>/sessions/<pid>.json`, where
`<config>` is `CLAUDE_CONFIG_DIR` or `~/.claude`. The pid and the socket must match for the
binding, and the session id must match too before each wake. Each turn hook binds the
session again, so the next ordinary prompt retries a failed binding.

- Claude Code 2.1.224 and later open the inbox, but ACC's captured minimum is 2.1.282. An
  older version reports `below_minimum_version` and keeps next-turn delivery.
- On native Windows, Claude Code serves its inbox on a named pipe that requires an auth
  line. ACC sends the key Claude Code publishes for other sessions of the same user; see
  [On Windows](#on-windows).
- Linux is uncaptured for live delivery. A Linux session keeps next-turn delivery.
- A wake that reached the session can still wait for your approval. See
  [the next section](#a-claude-code-session-holds-or-drops-acc-wakes).

If `deliveryBindings` is empty, ACC has not bound a local transport. Read the
per-session lines in `acc doctor`, or `nativeDelivery.sessions[].lastAttempt` in JSON:

- An absent or `off` policy means the installation record has no live-delivery consent
  for that client. Run `acc install --adapter <adapter> --delivery actionable` (or `all`).
- `client_process_unknown` means ACC could not identify the client process. A new client
  session repeats that lookup.
- For Claude Code, `native_endpoint_unavailable` means the hook environment had no
  `CLAUDE_CODE_MESSAGING_SOCKET`, or the socket failed ACC's safety checks.
  `native_session_unavailable` means the session registry is missing or names another
  session or socket.
- `handshake_failed` or `handshake_timeout` means the session could not bind its local
  transport. Check the client's integration. The next ordinary turn retries.
- No attempt observed can mean no native hook ran, an older runtime wrote the owner, or
  diagnostic persistence failed. Check hook activation and the runtime versions in doctor.

The timestamp describes the last attempt for that exact generation. A past successful
handshake does not establish a currently reachable channel or client-side admission.

Closing a Codex terminal can leave its daemon thread loaded and eligible. Use
`acc install --adapter codex --delivery off` to stop new ACC native offers.
Already accepted queue entries remain with the vendor. Actual thread archive
requires Codex's confirmation and produces `SessionEnd`.

## A Claude Code session holds or drops ACC wakes

Claude Code applies its own inbound controls to each ACC wake. These controls stay yours.
ACC never attests a permission mode, never reads the session's messaging token or key file,
and sends no auth line.

- A session in a prompting mode (`default`, `auto`, `acceptEdits` or `dontAsk`) takes each
  wake.
- A session in `bypassPermissions` mode holds each wake for your approval. To let such a
  session take wakes without approval, set Claude Code's `crossSessionInbound` setting to
  `accept`.
- A session with `crossSessionInbound` set to `refuse` drops each wake. ACC then sends
  none: the message stays `queued` with `delivery_disabled` and arrives with the next turn.

ACC reads the same inputs Claude Code reads: the hook's permission mode; before the first
prompt, whose hook carries none, the `--permission-mode` or `--dangerously-skip-permissions`
flag the session was started with, then `permissions.defaultMode`; and `crossSessionInbound`
from managed, local, project and user settings in that order. A held wake is still sent, because Claude
Code's approval dialog tells you a message is waiting, and the sender reads
`sent a wake to <participant> via claude-inbox, which its session holds for approval`.

The product re-run on 2.1.283 observed both the prompting case and a `bypassPermissions`
session holding the wake. When live delivery is on and your user or managed settings do not
say `accept`, `acc doctor` prints a `Claude Code inbound:` line naming the setting and the
file.

In every case the message stays durable. The receipt stays `queued` until the session's
next-turn hook shows the body. The message arrives with the session's next turn, and
`acc inbox` shows it at any time. The sender's `acc message` output still reports
`woke <participant> via claude-inbox`, because the wake reached the inbox.

## Codex plugin is listed but inactive

Open `/plugins` in Codex and check ACC is enabled. Open `/hooks`, review each ACC hook,
and enable/trust its current definition if needed; then restart the session. New or changed
definitions need review, and a trusted hook can still be disabled.

`acc doctor` reports installed files separately from hook readiness, which it leaves
unverified. A saved trust record cannot prove current activation. If installation preserved
your own legacy sandbox configuration, doctor also names the ACC state directory whose
access you should check in `sandbox_workspace_write.writable_roots`. Live delivery requires
local socket permissions as well; a writable state directory alone is insufficient.

## Gemini does not guard a write

Default and `plan` modes expose no write tool to the model. `auto_edit` exposes edit tools;
shell availability depends on approval mode. Gemini CLI next-turn delivery is certified from
0.57.0 onward, on every platform; an older client still uses inbox.

From 0.55 onwards there is a quieter cause with the same symptom: an untrusted folder. The
client prints `Approval mode overridden to "default" because the current folder is not
trusted` and keeps going, and the default mode has no write or shell tool to guard - so the
guard never fires and the mode you passed appears to have been ignored. Trust the folder,
or start the session somewhere trusted.

## Antigravity is installed and nothing happens

The most likely cause is that the session has no open workspace. Antigravity CLI gives its
hooks a project directory only through `workspacePaths`, and that array is empty unless the
session has one. The interactive TUI started in a project directory has one; a print-mode
`agy -p "..."` started in the same directory does not. The
hook then has no workspace to join, fails open as every ACC hook must, and this client shows
no hook output, so nothing anywhere says why.

Open the project as an Antigravity workspace, or pass it explicitly:

```
agy -p "..." --add-dir /path/to/project
```

The first TUI session in a folder you trusted at that same launch has no workspace either,
even with `--add-dir`; start the TUI again once the folder is trusted.

`acc doctor` names this state. Nothing else in the payload can substitute for it:
`transcriptPath` and `artifactDirectoryPath` both point inside the client's own
per-conversation directory, and the hook process does not inherit the directory the client
was started in.

If the session does have a workspace and ACC is still absent, check that the registration
actually loaded rather than that the file exists:

```
agy -p "/hooks" --output-format json
```

This client accepts a hook configuration it will not load and reports nothing. A file on
disk is not a registration: the Gemini CLI hook shape loads nothing here, an unsupported
event name is dropped out of an otherwise valid namespace, and one top-level key that is not
an integration namespace drops the whole file. The command above is the only answer that
counts.

The agent may see two ACC skills: `acc:acc`, which `acc install` puts there, and
`agents-can-communicate:acc`. The second is this client's own copy of ACC's Gemini CLI
extension, made on its first authenticated run into `~/.gemini/antigravity-cli/plugins/`. Its
skill loads, but none of its hooks do, and every command in it runs the Gemini CLI extension's
shim - so it works only while Gemini CLI is wired. `acc:acc` is the one to rely on; check what
the client actually loaded with:

```
agy -p "/skills" --output-format json
```

`agy plugin list` is not that check: it lists only plugins installed through
`agy plugin install`, and reports none while the imported skill above is loaded.

An agent that receives a peer message in print mode (`agy -p`) cannot answer it on its own.
It forms the right `acc reply` command from the skill, and print mode denies every command
because it cannot ask for approval; the client says so on stderr and names
`permissions.allow` in its settings. The TUI asks instead. The one rule ACC's install adds
there is described in
[Antigravity CLI command approval](CONFIGURATION.md#antigravity-cli-command-approval); it was
captured in the TUI, and print mode with it has not been captured.

## Antigravity never wakes while idle

Live delivery needs four things, and `acc doctor` shows each:

- the live policy is on: `acc install --adapter antigravity --delivery actionable` (or `all`);
- the session is interactive - print mode ends with its turn and never runs a relay;
- the session attached to ACC at all (see the section above);
- the agent started the relay. While none is running, ACC's context asks up to three times
  in that conversation. A declined prompt and an ignored ask look the same, so the line can
  return after a decline; after the third ask it stays quiet. ACC's install allows that
  command, so the agent starts it without an approval prompt; `acc doctor` names the rule when
  it is missing. Run `sh "~/.gemini/config/acc/acc-relay.sh" start` to start it directly.

`acc doctor` reports how many relays are running and, per session, whether a live transport is
active. A relay ends with its client; nothing is left running after the TUI exits or after
`acc uninstall`.

## Antigravity wakes and never answers

A woken session that stops at an approval prompt answers only once someone approves its
first ACC command. `acc doctor` prints an `Antigravity CLI inbound:` line with what it found in
`~/.gemini/antigravity-cli/settings.json`:

- **No rule.** Each ACC command waits for approval. ACC's install writes the rule, so it was
  removed since or the install did not reach this file: run `acc install --adapter antigravity`,
  then restart `agy`. Doctor lists this under what to run next.
- **The rule is present.** The client reads it at startup, so a session started before it was
  added still asks; restart `agy`. If a prompt still appears, check the command the agent
  ran: a path in quotes, or a command wrapped in `sh -c`, matches no rule.
- **The rule cannot apply.** The path to ACC's wrapper contains a space or a shell
  metacharacter, so it needs quotes, and a quoted first word matches no rule. ACC adds no
  rule and approvals stay manual.
- **The file cannot be read.** ACC leaves an invalid `settings.json` as it is. Repair it, then
  run `acc install --adapter antigravity` again.

Antigravity 2.0, the desktop app, runs the agent's commands in a sandbox where ACC's wrapper
cannot run, and the model then asks to run it outside the sandbox. The app decides that from
its own grants in `~/.gemini/config/config.json`, never from Antigravity CLI's settings. ACC's
install adds its rule there once the app has run, and `acc doctor` prints its state on a line
that names the desktop app. Restart the app after an install if it was open.

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

## On Windows

- **A session attaches only on its first prompt.** ACC reads the process tree through
  PowerShell, and the first start after boot can take several seconds. A hook that runs out of
  time continues without ACC, and the next user prompt attaches the session.
- **A hook reports `node` is not recognized.** Grok and Antigravity CLI hooks start `node` from
  `PATH`. Add Node.js to the `PATH` the client sees, then restart the client.
- **Claude Code hooks do nothing.** ACC wires Claude Code's hooks in exec form, which needs
  Claude Code 2.1.139 or later. Update Claude Code and run `acc install` again.
- **`acc install` refuses Antigravity CLI because of a space.** Antigravity CLI cannot run a
  quoted hook path, so ACC writes the 8.3 short name of a path with a space. A volume with 8.3
  names turned off has none; turn them on (`fsutil 8dot3name set C: 0`, as an administrator)
  and run `acc install` again.
- **A write through Claude Code's PowerShell tool was not guarded.** The guard reads POSIX shell
  commands only. Claims are advisory by default, and a write through Claude Code's Write, Edit or
  Bash tool is still checked.
- **Codex is not woken on Windows.** Codex refuses to start its app-server daemon from an
  elevated terminal ("start the Windows daemon from a non-elevated terminal"). Start Codex from a
  terminal that is not running as administrator, and keep `CODEX_HOME` short: the daemon's socket
  path has to fit 108 bytes, or Codex runs the chat on its own embedded server, which no peer can
  reach.
- **Hooks run out of time on a cloud machine.** A Windows flush waits for the whole disk to
  write out its cache. On a GitHub `windows-latest` runner, whose system disk is remote, a 4 KB
  flush took 10-33 ms at the median and up to 1.5 s, against 0.5 ms and at most 27 ms on its
  local disk. A session start flushes 5 to 16 times, so a disk like that can run a hook out of
  its five seconds; the session then attaches on a later prompt. Point `ACC_DATA_HOME` at a
  directory on a local disk that only your account can read, for every client, and restart
  them.
- **A Claude Code session is not woken on Windows.** The wake authenticates with the key Claude
  Code publishes beside its session record (`<config>\sessions\<pid>.<hash>.key`). Run
  `acc doctor`: a session without that key, or whose pipe the machine no longer lists, waits for
  its next turn.

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
`acc/runtime` tree, because the runtime launchers and their leases need the same data home.

Next: [Getting started](GETTING_STARTED.md) · [Capabilities](CAPABILITIES.md) ·
[Configuration](CONFIGURATION.md)

## An automatic update is pending

Run `acc doctor` to see the update policy and pending notice. A hold keeps an update
pending only while the store contract it declares differs from the incoming version's or
is unknown. ACC can recover a missing contract from the process's unchanged managed
generation when that generation declares one. A generation that predates the declaration
still needs its processes to exit. `acc update` names each remaining hold with its process and
its declared contract. ACC process leases, including persistent MCP servers, end on
confirmed process exit. Native bindings clear on observed SessionEnd or confirmed process
death; a vendor daemon may remain alive after SessionEnd. Unknown PIDs remain holds until
lifecycle cleanup. Close the client sessions and ACC processes the notice names;
`finish`, presence TTL, and delivery off do not prove native end.
`acc update` can offer a confirmed restart of an eligible Codex service. Unknown or
unrelated holds still require lifecycle cleanup or confirmed process exit; safety holds
do not expire merely by elapsed time. See
[maintenance and recovery](UPGRADING.md#confirmed-client-service-maintenance).

If ACC 0.5.3 or 0.5.4 reports a Claude Code Channel process with `contract unknown` after
an earlier 0.4.x upgrade, its active pointer may have lost the contract field. This can
affect Channel processes opened after that upgrade too. A pending old updater retries its
downloaded release without looking for a newer fix. Install the current global CLI, then use
that CLI to complete the update:

```bash
npm install -g agents-can-communicate@latest
acc update
acc doctor
```

The new reader can activate a compatible release while those processes remain open.
It still waits for different contracts, unknown native bindings, or generation files it
cannot verify. See [legacy contract recovery](UPGRADING.md#recover-missing-runtime-contracts).
Current releases retire the Channel path. See [upgrading from 0.7.x](UPGRADING.md#from-07x).

Use `acc update` to retry a failed download or finish an interrupted integration refresh.
A download failure keeps the working version. A partial integration refresh blocks
workspace commands until recovery completes, while hooks let the client continue without
ACC context. `acc update` names the failed adapter, cause, and known configuration paths;
fix that problem and rerun it. Help and update recovery remain available. `ACC_NO_UPDATE_CHECK=1` prevents
new downloads but permits manual activation of an already verified pending update.

To stop automatic downloads, use `acc update --auto off`. To stay on the current release,
use `acc update --pin <version>`. Neither setting converts workspace data for an older
runtime. See the [upgrade guide](UPGRADING.md).
