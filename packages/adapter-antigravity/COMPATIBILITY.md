# Antigravity CLI compatibility

Investigation notes for issue #174, and the evidence this package's adapter rests on. Every
line below is either observed on a live install or labelled as not observed.

Three capabilities are certified from these captures - `lifecycle.sessionStart`,
`context.beforeTurnInjection` and `delivery.nextTurn`. Everything else in the fourteen-entry
capability shape is false, and most of it is false because the event it would need does not
exist on this client rather than because nobody tried.

Capture host: macOS arm64, Antigravity CLI **1.2.7**, installed from the official installer to
`~/.local/bin/agy` (189,658,880 bytes). Model served during the capture: `gemini-3.8-flash-high`.
Observed 2026-09-20.

## Hook configuration

### Schema

Hooks are namespaced by integration at the top level, then by event. This is the only shape
that loads:

```json
{
  "acc": {
    "SessionStart": [{ "type": "command", "command": "…", "timeout": 10 }]
  }
}
```

The Gemini CLI shape — a flat event map whose entries carry `matcher` and a nested `hooks`
array — is **silently ignored**. So is a config wrapped in a top-level `hooks` key. Nothing is
logged and no error is produced; `/hooks` simply reports an empty list. ACC writes exactly this
Gemini shape into `~/.gemini/settings.json` for its Gemini CLI extension, so an ACC install that
is carried into Antigravity registers nothing.

### Locations

| Path | Loads |
|---|---|
| `~/.gemini/config/hooks.json` | yes, always |
| `<workspace>/.agents/hooks.json` | yes, **only when that directory is an open workspace** |
| `<workspace>/.agent/hooks.json` | no |

A workspace-local config is not picked up merely because the process runs with that directory as
its working directory. In print mode it loaded only when the directory was passed with
`--add-dir`. An adapter that writes `.agents/hooks.json` into a project must therefore also make
sure the project is opened as a workspace, or fall back to the global config.

### Reading a registration back

`agy -p "/hooks" --output-format json` answers without starting a turn or spending quota, and
its `command.data` is the effective hook list:

```json
{ "hooks": [ { "name": "acc", "enabled": true,
  "source": "<workspace>/.agents/hooks.json",
  "actions": [ { "event": "SessionStart", "type": "command",
    "command": "sh \"<path>/acc-hook.sh\" SessionStart", "timeout_seconds": 10 } ] } ] }
```

The namespace key becomes `name`; `source` names the file it was loaded from; `timeout` is
read back as `timeout_seconds`. This is the only thing on the machine that can tell a working
registration from an inert one, which is why install and doctor both read it rather than
trusting the file they wrote. Six answers were captured, and four of them are failures that
look identical on disk to a success:

| What was written | Effective hook list | Fixture |
|---|---|---|
| Nothing at all | `[]` | `fixtures/hooks-readback-empty-1.2.7.json` |
| The namespaced shape, three supported events | all three, with `source` | `fixtures/hooks-readback-registered-1.2.7.json` |
| The namespaced shape, plus `SessionEnd` and `PreToolUse` | **only the supported event** | `fixtures/hooks-readback-dropped-1.2.7.json` |
| The Gemini CLI shape ACC writes today | `[]` | `fixtures/hooks-readback-gemini-shape-1.2.7.json` |
| A valid namespace **plus one extra top-level key** | `[]` | `fixtures/hooks-readback-foreign-key-1.2.7.json` |
| The same namespace name in both locations | **only the global one, whole** | `fixtures/hooks-readback-namespace-collision-1.2.7.json` |

Three of those are new findings, and each one changed the adapter:

- **One unrecognised top-level key drops the whole file.** Every top-level key is read as an
  integration namespace, and a key whose value is not an event map takes every valid namespace
  in the file down with it. The marker the Gemini CLI adapter writes into `settings.json` -
  `"acc:createdFile": true` - registered *nothing at all* here, valid `acc` namespace included.
  So this adapter records "ACC created this file" beside its shim rather than inside the
  client's file, and writes nothing into that file but namespaces.
- **An unsupported event is dropped per action, not per file.** A namespace carrying
  `SessionStart`, `SessionEnd` and `PreToolUse` loads, with only `SessionStart` in it. A
  partially registered install is therefore indistinguishable from a complete one without the
  read-back.
- **Two locations with the same namespace name do not merge.** Global and workspace configs
  merge when their namespaces differ - each appears separately with its own `source`. Give both
  the name `acc` and only the global one survives; the workspace one is discarded entirely,
  including the events the global one does not carry. A machine can therefore hold a correct
  workspace registration that never runs.

The adapter's own configuration was round-tripped against the live client on 2026-09-20:
`installAntigravity` wrote a workspace registration, real `agy -p "/hooks" --output-format
json` reported `SessionStart, PreInvocation, Stop` with that file as its `source`,
`doctorAntigravity` read the same back, and after `uninstallAntigravity` the client reported
an empty list. The probe, the parse and the removal are the real ones; only the model was
never asked for a turn.

A command quoted for a path containing a space - `sh "<dir with space>/probe.sh" SessionStart` -
loads, is read back verbatim, and runs: in a real turn the script ran from a directory with
spaces in it and received the event name as its first argument, which is the argument this
adapter reads the event from (`fixtures/hook-command-space-path-1.2.7.json`). A home directory
with a space in it is therefore not a reason for ACC's hooks to fail here.

### Where ACC registers

**Global, `~/.gemini/config/hooks.json`** — decided in issue #178. It is the location that
always loads, and it is where ACC already registers for every other client that keeps hooks in
the user's home. A workspace registration is available with `ACC_ANTIGRAVITY_HOOKS=workspace`;
it is not the default because a workspace file in a folder nobody opened as a workspace
registers nothing and reports nothing, and a default that silently does nothing is worse than
one that is broader than a given project needs.

A value that is neither is refused by name and that client is skipped, rather than being
replaced by the default. An operator who asked for `workspace` and got the machine-wide file
would have no way of finding out except by reading the file.

| | Global `~/.gemini/config/hooks.json` | Workspace `<project>/.agents/hooks.json` |
|---|---|---|
| Loads | always | only while that project is an open workspace |
| Scope | every Antigravity session on the machine, in any directory | one project |
| Fails as | ACC hooks run in projects that never asked for them | registers nothing, silently, with a file that looks correct |
| Uninstall | one file | one file per project ever installed into |

The namespace collision above bears on this: if both are ever written with the name `acc`, the
global one wins and the workspace one is discarded whole. The two cannot be combined as a
belt-and-braces install.

The **open workspace requirement** below qualifies this choice. A global registration runs in
every Antigravity session, including the ones that have no open workspace and therefore give
the hook no project to join; those turns do nothing and say nothing. A workspace registration
only loads where a workspace exists, so it never reaches that state — at the cost of loading
nowhere else. Global remains the default because it is the one that cannot be silently absent, and the
interactive TUI — the ordinary way to use this client — always has a workspace, so the
no-workspace case is confined to print mode without `--add-dir`. `acc doctor` names it.

ACC's own bookkeeping — which `hooks.json` files ACC created and may therefore delete — lives
in ACC's data home, never in the client's tree. A marker inside `hooks.json` drops the whole
file, and a marker beside the shim is deleted by the installer before `uninstall` runs; both
were observed.

### Supported events

Each event was registered alone, and then together, and the effective set read back from
`agy -p "/hooks" --output-format json`, which answers without starting a turn or spending quota.

| Event | Loads | Fired in the capture |
|---|---|---|
| `SessionStart` | yes | yes, once |
| `PreInvocation` | yes | yes, once per invocation |
| `PostInvocation` | yes | yes, once per invocation |
| `Stop` | yes | yes, once per execution |
| `SessionEnd` | **no** | — |
| `PreToolUse` | **no** | — |
| `PostToolUse` | **no** | — |
| `Notification` | **no** | — |
| `turn-completion` | **no** | — |
| `BeforeAgent`, `AfterAgent`, `BeforeTool`, `AfterTool` (Gemini CLI names) | **no** | — |

`PreToolUse` was also tried with `matcher` inside the action, with `matcher` as a nested key, and
with a `tool` field. None loaded. `turn-completion` does not appear anywhere in the 1.2.7 binary,
as an exact string or a substring.

Consequences for ACC:

- **No tool guard.** There is no `guards.beforeWrite` equivalent. A claim cannot be enforced at
  write time on this client the way it is on Gemini CLI.
- **No session end.** Participant deregistration cannot ride on a lifecycle event; it has to come
  from the user, or be inferred. What this adapter does about it: nothing automatic, and it says
  so. `lifecycle.sessionEnd` is false, which makes the session's lifecycle `manual` in its own
  participant record: the record stays `open` until an explicit `acc finish`. What keeps it from
  lingering in the roster is presence, not lifecycle. The hook records the pid of the `agy`
  process it runs under, and once that process exits the participant stops being listed —
  observed for print-mode turns and for a TUI ended by signal. Messages addressed to it still
  queue durably and are offered if the same conversation is resumed. Inferring an end from
  `Stop` would retire a session that is merely between turns, and `fullyIdle` says nothing
  about whether the process is still alive, so neither is used.

## The open workspace requirement

**`workspacePaths` is empty unless the session has an open workspace, and an ordinary
`agy -p` in a project directory does not have one.** Everything in this document above was
captured with `--add-dir`, which populates it; the first real turn through an installed ACC
found the ordinary case and registered nothing at all.

```
$ cd ~/project && agy -p "..."          # workspacePaths: []   -> ACC attaches nothing
$ cd ~/project && agy -p "..." --add-dir ~/project
                                         # workspacePaths: ["/…/project"] -> ACC attaches
```

Fixtures: `fixtures/SessionStart-no-workspace-1.2.7.json`,
`fixtures/Stop-no-workspace-1.2.7.json`.

Nothing else in the payload can stand in for it:

- `transcriptPath` and `artifactDirectoryPath` both point inside
  `~/.gemini/antigravity-cli/brain/<conversationId>/`. That is the client's own state and it
  is per conversation, so adopting it would give every conversation a private ACC workspace
  and two agents in one project would never see each other.
- **The hook process does not inherit the client's directory.** Its working directory is the
  directory of the `hooks.json` it was registered from — `~/.gemini/config` for a global
  registration, captured in `fixtures/hook-process-environment-1.2.7.json`. A turn started in
  `~/project` runs its hook in `~/.gemini/config`.

So the adapter refuses, and refuses by name with `reasonCode: "antigravity_no_open_workspace"`.
This client does not surface hook stderr, so a fail-open refusal here is invisible — which is
exactly the issue #176 appearance of "everything is installed and nothing happens". `acc doctor`
carries the line instead.

**The TUI does have one.** Started the ordinary interactive way — `agy` in a project directory,
no `--add-dir` — every hook in the turn received `workspacePaths` naming that directory, and ACC
attached a participant that stayed `online` while the TUI was open
(`fixtures/PreInvocation-tui-1.2.7.json`). The empty array is therefore a print-mode case:
`agy -p` without `--add-dir`. The hook's working directory was `~/.gemini/config` in the TUI
too, so the payload remains the only source of the project.

This is independent of where the hooks are registered. Registration decides whether the hook
*runs*; an open workspace decides whether ACC can identify a *project*. A global registration
runs in every session and does nothing in those that have no workspace; a workspace
registration only loads when there is one, so whenever it runs it works.

## Verified end to end on a real machine

2026-09-20, Antigravity CLI 1.2.7, macOS arm64, through the installed `acc` CLI rather than
through a harness:

| Step | Result |
|---|---|
| `acc install --adapter antigravity` | wrote `~/.gemini/config/hooks.json`; real `agy -p "/hooks"` reported `acc` with SessionStart, PreInvocation and Stop |
| `acc doctor` | `present: true`, `version: 1.2.7`, `installed: true`, read back from the client |
| a real turn with `--add-dir` | ACC attached: participant `antigravity-…`, `lifecycle: manual`, `enforcement: advisory` |
| a real turn without `--add-dir` | no session; `workspacePaths` was empty |
| `PreInvocation` injection | the model reproduced the injected ACC owner header verbatim |
| a peer message, then one more turn | the model replied with the peer's probe token, so a peer body reaches the model |
| receipts afterwards | the delivered message advanced to `offered`; one addressed to a session that never ran again stayed `queued` |
| `acc uninstall --adapter antigravity` | `hooks.json` and the shim directory removed; `agy` reported an empty hook list; `~/.gemini/settings.json` and `~/.gemini/extensions/agents-can-communicate` byte-identical |

The same install was then driven through the interactive TUI, in a Terminal window, with no
`--add-dir`:

| Step | Result |
|---|---|
| `agy` opened in the project directory | `workspacePaths` named the project at every hook |
| ACC | participant attached, `presence: online` for as long as the TUI stayed open |
| one user turn | `PreInvocation` fired three times — once per model invocation, one per tool-call round |
| a peer message queued while that turn was running | appeared in the client's own transcript as a `SYSTEM_SDK` `EPHEMERAL_MESSAGE` at the **next invocation of the same turn**, after a tool call; receipt `offered` |

Fixture: `fixtures/tui-transcript-injection-1.2.7.json`. The capture harness's keystrokes
reached the TUI as a single `.`, so the model was never asked to repeat the token and did not;
the transcript is the evidence that the body was placed in its context, and the model's next
planner step referred to the injected ACC details.

### Mid-turn delivery — observed, not certified

Because `PreInvocation` runs before every model invocation, not once per user prompt, a peer
message that arrives while an agentic turn is in progress is offered at the next tool-call
boundary of that turn. That is the behaviour `context.safePointInjection` describes. It is
**not declared**: the certification here was scoped to session start, before-turn injection
and next-turn delivery, and a single capture with a mangled prompt is thin evidence for a
fourth capability. It is the strongest candidate this client offers for one.

That round trip also found the bookkeeping bug described under **Locations**: the installer
removes recorded artifacts before calling `uninstall`, so the "ACC created this file" marker
cannot live beside the shim.

## Payload envelope

There is no `hook_event_name` field. The event is known only from how the command was invoked, so
the adapter must pass it as an argument.

Common to every event: `conversationId`, `modelName`, `transcriptPath`, `artifactDirectoryPath`,
`workspacePaths` (array).

- `PreInvocation` and `PostInvocation` add `invocationNum` and `initialNumSteps`. The two events
  carry byte-identical envelopes for the same invocation; they are not distinguishable from the
  payload alone.
- `Stop` adds `executionNum`, `terminationReason` (observed: `NO_TOOL_CALL`), `error`, and
  `fullyIdle` (observed: `true`). `fullyIdle` is the only idle/busy signal any event carries.

Fixtures: `fixtures/SessionStart-1.2.7.json`, `PreInvocation-1.2.7.json`,
`PostInvocation-1.2.7.json`, `Stop-1.2.7.json`, `Stop-continued-1.2.7.json`. Transcript,
artifact directory, workspace paths and conversation id are redacted; every other field is
verbatim.

## Delivery

### PreInvocation injection — observed

Returning

```json
{ "injectSteps": [ { "ephemeralMessage": "…token…" } ] }
```

placed the text where the model read it: the model reproduced the probe token in its reply. This
is before-turn injection, equivalent in authority to the Gemini CLI `additionalContext` path.

`userMessage` and `toolCall` also appear as strings in the binary but were not exercised.

### Stop continuation — observed

Returning

```json
{ "decision": "continue", "reason": "…text…" }
```

from `Stop` did not end the turn. A second invocation ran, and the model reproduced the token
carried in `reason`, so the reason reaches the model — as a system-framed message, observed
later (see below).

**It is a bounded nudge, not a gate.** The vendor changelog for 1.1.9 records a fix for "stop
hooks that always block hanging the agent forever; after a configurable number of consecutive
continuations, the hook can no longer block and the turn ends normally". An adapter must impose
its own ceiling and fail open, and must not present a blocked turn as a guarantee that a peer
will be answered.

**Wired and observed end to end.** The hook runner's `turnEnd` handler continues a turn only
when the projector offers a peer body that no invocation has shown yet — never for an owner
header, an attention count or a degradation notice, because a continuation costs the operator
a model invocation. On a live 1.2.7 turn, a peer question sent after the turn's only
`PreInvocation` was delivered in that same turn: the client's transcript records a
`SYSTEM_MESSAGE` reading `Stop hook blocked termination: …` with the peer message in it, the
continued model loaded ACC's skill and formed the exact reply, and the receipt advanced to
`offered`. Without the continuation it would have waited for the next user prompt. Fixture:
`fixtures/stop-continuation-live-1.2.7.json`.

**The reason is presented with system framing.** The client wraps it in
`<SYSTEM_MESSAGE>` and prefixes it `Stop hook blocked termination:` — not user text, as earlier
notes here assumed. Peer text therefore reaches the model inside a system-framed block, and the
`acc-peer-message` fence marking it untrusted is the only thing telling the model it is data.

This adapter's ceiling is **one continuation per turn**, counted from the `executionNum` the
client itself supplies - `Stop-1.2.7.json` carries `0` and `Stop-continued-1.2.7.json` carries
`1`, so the counter is the client's rather than state ACC would have to keep between two
short-lived hook processes. `stopResponse` returns `{}` - which permits shutdown - for every
input that is not a non-empty reason below that ceiling, so a hook error, an expired budget and
an unreachable store all end in a turn that finishes normally. Nothing in the sender-facing
story says a peer will answer because a receiver's turn was continued.

### Live push — not reachable from ACC's hooks

`agy agentapi` exists as a hidden subcommand — it is absent from `agy --help` — exposing
`get-conversation-metadata`, `new-conversation` and `send-message <recipient_id> <content>`,
where the recipient is a conversation id: the same `conversationId` every hook payload carries.
No `agentapi` binary exists on disk under `~/.gemini/antigravity-cli/bin/`; the subcommand is
part of `agy` itself.

It is a client of the running session's own language server. Captured against an idle TUI
session (`fixtures/agentapi-reachability-1.2.7.json`):

- From outside the session it refuses at once: `ANTIGRAVITY_LS_ADDRESS is not set`.
- The session listens on two random local ports. Pointed at one, `agentapi` gets a transport
  error; pointed at the other, `Unauthenticated desc = missing CSRF token`. The token lives in
  `ANTIGRAVITY_CSRF_TOKEN`.
- **Hooks are given neither.** `SessionStart`, `PreInvocation` and `Stop` all received exactly
  one `ANTIGRAVITY_*` variable, `ANTIGRAVITY_CONVERSATION_ID`, recorded by name only.

So ACC's hooks cannot push into a running session, and `delivery.livePush` stays false.

**The agent's own tool shell can, and it wakes an idle session.** Captured on 2026-09-21 with
the operator performing the token step himself (`fixtures/agentapi-live-push-1.2.7.json`):

- The shell an agent runs commands in carries all three: `ANTIGRAVITY_CONVERSATION_ID`,
  `ANTIGRAVITY_LS_ADDRESS` and `ANTIGRAVITY_CSRF_TOKEN`.
- With that endpoint, a separate process's `agy agentapi send-message <conversation> <text>`
  was accepted, and the **idle** TUI session woke within a second: a `SYSTEM_MESSAGE`
  carrying the text, then the model's own reply, with no user input at all.
- `get-conversation-metadata` answered with the conversation's workspace folders and root id.

That is a working live-push surface, and the only one this client offers. What using it would
cost, all observed rather than assumed:

- **A live session credential.** ACC would have to take the CSRF token out of the agent's
  shell and keep it; anything that can read it can drive the user's agent until the session
  ends. An auto-mode coding agent was refused permission to do exactly this twice, as
  credential materialization.
- **The agent's cooperation, every session.** Only the agent's shell has the endpoint, so the
  agent has to run a binding command. That needs command approval — a prompt in the TUI, an
  outright denial in print mode — and in one attempt the model refused to run a script it took
  for a bind shell.
- **System framing.** The pushed text reaches the model as a `SYSTEM_MESSAGE`, as a `Stop`
  reason does; the untrusted-peer fence is what marks peer text as data.

None of it is built. What already reaches a running session without any credential is the next
invocation's `PreInvocation` and the end-of-turn `Stop` continuation.

### Reply routing — not observed

`delivery.replyRoute` stays false.

## MCP registration

`agy mcp add|remove|list|enable|disable` manages the user-level `mcp_config.json` and has existed
since 1.1.16. An adapter should use it rather than writing the file.

Two paths exist and both were present on the capture host with `{"mcpServers": {}}`:
`~/.gemini/config/mcp_config.json` is current, `~/.gemini/antigravity/mcp_config.json` is the
legacy location. The 1.0.3 changelog entry describes the migration between them, so a leftover
legacy file is expected rather than a sign of a second active configuration. Detection must not
infer the install from either path.

## Skills and plugins

Captured through `agy -p "/skills" --output-format json`, which answers without a turn and is
the only read-back that says which skills loaded.

- **Two discovery roots load globally**: `~/.gemini/config/skills/<name>/SKILL.md` as `<name>`,
  and `~/.gemini/config/plugins/<plugin>/skills/<skill>/SKILL.md` as `<plugin>:<skill>`.
- **So does the import directory**, which the vendor's own customization guide does not list:
  the auto-imported copy under `~/.gemini/antigravity-cli/plugins/agents-can-communicate/`
  loads as `agents-can-communicate:acc`, model-invocable.
- **`agy plugin list` is not a read-back.** It lists only plugins installed through
  `agy plugin install`, and printed `No imported plugins.` while that imported skill was
  loaded.
- **`agy plugin install <dir>`** copies the whole directory to `~/.gemini/config/plugins/<name>/`
  and records it in `~/.gemini/config/import_manifest.json`. It needs no signed-in account.
  Installing again overwrites.
- **`agy plugin uninstall <name>`** removes the directory and leaves the manifest behind holding
  `{"imports": null}` — a file that did not exist before the first install. It does not touch
  the imported copy.
- **A same-named plugin is shadowed by the imported copy.** A plugin named
  `agents-can-communicate` installed beside the import was silently hidden; `/skills` listed
  only the imported one. A plugin named `acc` loads beside it as `acc:acc`.

Fixtures: `fixtures/skills-readback-1.2.7.json`, `fixtures/plugin-name-collision-1.2.7.json`,
`fixtures/plugin-install-lifecycle-1.2.7.json`.

What the adapter does with this: it installs its own plugin, named `acc`, through
`agy plugin install`, carrying the same ACC skill every other client ships, with the command
baked to ACC's own CLI shim in `~/.gemini/config/acc/`. It then requires `/skills` to list
`acc:acc` from that directory, and fails the install when it does not. Uninstall goes back
through `agy plugin uninstall acc`, and removes the manifest when ACC's install is why it
exists and nothing but `null` is left in it. Both the plugin directory and the manifest are
declared to the installer as delegated, so the installer never deletes them ahead of the
client's own command.

**It reaches the model, and the model uses it.** In a print-mode conversation resumed with
`--conversation`, the model's first tool call in answer to the injected owner header alone was
`view_file` on `~/.gemini/config/plugins/acc/skills/acc/SKILL.md` — ACC's plugin, not the
imported copy. Given a peer question with a reply obligation that needed no tools, its first
call was exactly the reply the skill teaches: ACC's own shim, the right message id, the right
answer, and the owner arguments from the injected header. That same command line, run by hand,
recorded the reply. Fixture: `fixtures/headless-reply-attempt-1.2.7.json`.

**Headless mode cannot run it.** Print mode auto-denies any tool needing the `command`
permission, because it cannot prompt, and says so on stderr: *add an allow-rule under
`permissions.allow` in settings.json (e.g. `command(<target>)`)*. In the TUI the same call
raises the ordinary approval prompt. The adapter adds no allow rule: no other ACC adapter grants
itself command permission, and whether an agent may run ACC without asking is the operator's
decision. A headless agent therefore receives peer messages and knows the exact command to
answer them, and cannot send it until the operator allows it.

Why it cannot lean on the imported copy: all 23 commands in its skill run
`~/.gemini/extensions/agents-can-communicate/acc-cli.sh`, the Gemini CLI extension's shim. It
works exactly as long as Gemini CLI is wired, and not on a machine that never had it.

Why it matters: the owner header ACC injects tells the model to load the acc skill. With no
skill it can use, a TUI session given only that header went looking for `acc` itself —
`which acc; find ~/.gemini -name "*acc*"; find ~/.claude …` — and stopped at a permission
prompt, which was declined.

`agy` is always run with `HOME` set to the home being installed into. It honours it, and it
also writes its own state into whatever home it is given (`.gemini/antigravity-cli/`,
`Library/Caches`), so detection does not run it at all for a client the installer did not find.

## Plugin import

On first authenticated run, AGY copied the ACC Gemini CLI extension from `~/.gemini/extensions/`
into `~/.gemini/antigravity-cli/plugins/agents-can-communicate/`, byte for byte, and generated a
`plugin.json` carrying only name, version and description. `agy plugin list` still reports "No
imported plugins" and `agy mcp list` reports "No MCP servers configured".

So a machine can hold a complete copy of the ACC integration while ACC's hooks are invisible
to the client: the files are there, the hook names are Gemini CLI's, and no hook is
registered. Its skill, however, does load — see **Skills and plugins** above. Any
report that ACC "is already present" on an Antigravity install has to be checked against
`agy -p "/hooks"`, `agy -p "/skills"` and `agy mcp list`, not against the presence of files -
and not against `agy plugin list`, which does not list the imported copy at all.

## Version floors to consider

From the vendor changelog, not from capture:

- **1.1.10** — hooks began running before the built-in termination checks, "which lets `Stop`
  hooks run at all instead of sitting unreachable behind the built-ins".
- **1.2.4** — fixed `hooks.json` being "silently dropped when customization token budget
  truncation is active".
- **1.1.16** — `agy mcp` subcommands.
- **1.1.1** — fixed workspace `.agents/hooks.json` not loading after trusting a folder.

## Not observed

- Any behaviour on Linux or Windows.
- `userMessage` and `toolCall` injection types.
- Whether `agentapi send-message` into a *busy* session queues until the turn ends or
  interrupts it. Only an idle session was pushed into.
- How long the endpoint stays valid: across a TUI restart, after `/clear`, or while the
  session waits at a permission prompt.
- Reply routing back to ACC.
- The client's own continuation ceiling, and what the model is told when that is reached. What
  it is told on a continuation is observed: see **Stop continuation** above.
- Interactive-session behaviour beyond one TUI turn. The TUI was driven once, with a harness
  whose keystrokes arrived as `.`; the model was never asked to act on a peer message there.
- Whether a mid-turn injection changes what the model does in the rest of that turn.
- Whether `--continue` reliably keeps one conversation id. Two successive `-c` runs produced
  different ACC sessions, so a print-mode conversation is not a stable participant.
- Which of two same-named namespaces wins on load order rather than on location: the one capture
  had the global file winning, and a workspace-first ordering was not constructed.
- Whether a `PostInvocation` registration costs anything measurable. It is not registered,
  because its envelope is byte-identical to `PreInvocation`'s and there is nothing ACC would do
  there twice.
