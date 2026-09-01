# Capabilities

Capability honesty is part of the product: ACC coordinates sessions it does not own, so a
workspace can promise only what every session in it actually exposes — one weaker
participant lowers the reported protection level instead of inheriting a stronger label
from its peers.

Every row below is **measured**, not asserted: a `yes` has a fixture captured from a real
session of that client version; a `no` means the behavior was not observed, not that it is
impossible. Certified 2026-08-16 on macOS 15 (darwin 25.5.0, arm64) only — at least one
finding here is filesystem- and path-shaped, so re-run the table before trusting it on
another platform.

## Clients

| Adapter | Client | Version |
|---|---|---|
| `codex` | `codex-cli` | 0.147.0 |
| `claude_code` | Claude Code | 2.1.233 |
| `gemini_cli` | Gemini CLI | 0.37.0 and 0.55.1 |
| `grok` | Grok | 1.0.13 |
| `kimi` | Kimi Code | 0.36.1 |

## Matrix

| Capability | codex | claude_code | gemini_cli | grok | kimi |
|---|---|---|---|---|---|
| `lifecycle.sessionStart` | yes | yes | yes | yes | yes |
| `lifecycle.sessionResume` | no | no | no | no | no |
| `lifecycle.sessionEnd` | yes | yes | yes | yes | no |
| `lifecycle.heartbeat` | no | no | no | no | yes |
| `lifecycle.childSessions` | no | no | no | no | no |
| `context.startupInjection` | no | no | no | no | no |
| `context.beforeTurnInjection` | yes | yes | yes | no | yes |
| `context.safePointInjection` | no | no | no | no | no |
| `guards.beforeRead` | no | no | no | no | no |
| `guards.beforeWrite` | yes | yes | yes | no | yes |
| `guards.beforeShell` | yes | yes | yes | no | yes |
| `delivery.polling` | yes | yes | yes | yes | yes |
| `delivery.activeNotification` | no | no | no | no | no |
| `delivery.wakeDormantSession` | no | no | no | no | no |
| `execution.launch` | no | no | no | no | no |
| `execution.resume` | no | no | no | no | no |
| `execution.terminate` | no | no | no | no | no |

## Resolving a client's pid is not universal either

Not a capability above — no adapter method backs it, so it has no row in the matrix — but
it is presence's other signal for telling a dead process from an idle one, and it does not
reach every client.

A session's recorded pid comes from walking its process ancestry until the adapter's own
declared binary (`client.command`) turns up in `ps -o comm=`. That only works when the
operating system's own name for the process actually is that binary: true for a native
executable, false for a script run through an interpreter, where `comm` reports the
interpreter's name rather than the script's.

| Client | `client.command` | `ps -o comm=` reports | Pid resolves |
|---|---|---|---|
| `codex` | `codex` | `codex`, a native binary | yes |
| `claude_code` | `claude` | `claude`, a native binary | yes |
| `gemini_cli` | `gemini` | `node` — `gemini.js` starts `#!/usr/bin/env node` | **no** |
| `grok` | `grok` | `grok`, a native Mach-O at `~/.grok/bin/grok` | yes |
| `kimi` | `kimi` | not installed on the machine this table was measured on; Kimi Code ships via npm as a Node.js CLI (`@moonshot-ai/kimi-code`), the same shape as Gemini CLI | **almost certainly no — not measured** |

A Gemini session records `pid: null` for its whole life, and Kimi's is very likely the
same, unconfirmed. `null` is the correct "nobody knows" answer and is handled identically
wherever it is read — not a correctness bug. It does change what presence delivers, though:
a confirmed-dead pid retires a session immediately and exactly, and today that is `codex`,
`claude_code`, and `grok`. `gemini_cli` and `kimi` fall back to the same age-based floor every
session has for whenever a pid is unavailable — thirty minutes of silence — so their
sessions still leave, just later and on a timer instead of on the fact. See
[ARCHITECTURE.md](ARCHITECTURE.md#presence) for the full floor.

## What the yes values do not promise

A capability says the client can do the thing. Several of them are conditional on how the
client is being run, and the conditions differ per harness. These are the ones that bite.

**`guards.beforeWrite` on `codex` depends on the model.** Whether the client offers
`apply_patch` at all is a property of the model's metadata (`apply_patch_tool_type`), not
a user setting. With a model that does not have it, edits run through `exec_command`,
which reaches hooks as `tool_name: "Bash"` carrying a command string. A command names no
resource, so there is nothing to compare against a claim. Observed on 0.147.0: the default
toolset contained no `apply_patch`.

**`guards.beforeWrite` on `gemini_cli` depends on the approval mode.** In the default and
`plan` modes the client declares no write tool to the model at all. `write_file` and
`replace` appear under `auto_edit`; `run_shell_command` under `yolo`.

**`guards.beforeShell` is resource-aware where the write is unambiguous.** ACC reads the
command for its write positions only — a redirection, an operand of a command whose whole
job is to put bytes somewhere — and declares those paths as targets. Reading positions are
left alone: `cat file` and `grep file` name a path and write nothing, and treating them as
writes would have sessions blocking each other for looking.

What it does not see is a language runtime opening the file itself (`python3 -c
"open(...)"`), a command assembled at runtime, or an `eval`. A shell can still evade the
guard. Until 0.1.7 every shell write did, which is why partial sight is the improvement it
is: a session told to prefer the shell for file changes walked through every claim in the
workspace.

Where the guard cannot help, the turn context does: it names the claims other sessions
hold and says which way this session stands with them. Two facts decide the wording — what
the claim's owner asked for (`guarded` or `advisory`; see [Glossary](GLOSSARY.md)), and
whether ACC can stop this session at all:

| Claim | This session | Note |
|---|---|---|
| guarded | can be guarded | `file edits and recognised shell writes are blocked; a runtime can still get past` |
| guarded | cannot be guarded | `not enforced for this session; do not edit it` |
| advisory | either | `advisory; nothing will stop you, the owner is asking` |

Unenforceable is not the same as unknown — and neither is it the same as unclaimed.

**`lifecycle.sessionEnd` on `kimi` is false and it matters.** Each `kimi -p` run leaves an
attached session that never closes itself — it just stops taking turns. Presence retires it
instead, most likely without ever resolving a pid (see above), which means the session
reads `offline` — and disappears from the default `acc status` view — only after thirty
minutes of silence, not on its declared 60s heartbeat cadence. Interactive sessions
heartbeat and do not have this problem.

**`lifecycle.heartbeat` is Kimi's alone.** It fires on a timer — observed at 60002, 120004
and 180006 ms of uptime — so an idle Kimi session keeps its presence honest. The other
clients reach a hook only when the user takes a turn, so their idle sessions go stale while
alive. This is why it is a capability of its own rather than a flavour of
`delivery.polling`.

**`context.beforeTurnInjection` on `grok` is false.** Grok 1.0.13 discards
UserPromptSubmit stdout and `additionalContext`. The hook still runs (presence
and polling), but the model is not shown that text. Agents on this client read
`acc status` / `acc inbox` from the skill.

**`guards.beforeWrite` / `beforeShell` on `grok` are false.** PreToolUse fires, and
the matcher names `write`, `search_replace`, and `run_terminal_command`. A deny
has not yet been captured blocking a real call, so the capability stays false.

## Response contracts, which do not port

The single most portable-looking mistake an adapter can make. Measured by running each
candidate against a real session of each client and checking whether the tool actually
ran. A dash means the candidate was never run against that client, not that it fails —
only the shape each shipped adapter actually uses was measured on every client.

| Reply to a guard hook | codex | claude_code | gemini_cli | grok | kimi |
|---|---|---|---|---|---|
| exit code 2 | denies | - | denies | - | denies |
| `{"hookSpecificOutput":{…,"permissionDecision":"deny"}}` | - | denies | **ignored** | documented | denies |
| `{"decision":"deny","reason":…}` | - | - | - | documented | - |
| `{"decision":"block","reason":…}` | - | - | denies | - | **ignored** |
| `{"permission":"deny"}` | - | - | ignored | - | ignored |
| exit code 1 | - | - | ignored | - | ignored |

Codex has no structured reply at all: it denies by exiting 2 with the reason on stderr.
Gemini ignores the shape that Claude Code and Kimi Code both honour, and Kimi ignores the
shape Gemini needs. Each ignored case fails silently — the write goes through and the
client reports nothing.

Context injection does not follow the deny contract even within one client:

| Injection | codex | claude_code | gemini_cli | grok | kimi |
|---|---|---|---|---|---|
| `hookSpecificOutput.additionalContext` | - | works | works | **discarded** on UserPromptSubmit | works, but **not unwrapped** |
| plain text on stdout | works | - | dropped | **discarded** on UserPromptSubmit | works |

Codex delivers a hook's stdout as a `developer` role message, verbatim — the most direct
of the four channels, and a reason for care rather than comfort: at that role a model
reads text as instruction, so peer-authored text has to stay framed as data.

Kimi Code shows the model whatever a hook printed, wrapped in
`<hook_result hook_event="…">`, so the JSON envelope itself would end up in the
conversation. Gemini unwraps the envelope and appends `<hook_context>…</hook_context>` to
the user turn, and drops a bare string entirely.

These two tables are the measurement; they say nothing about how an adapter produces the
right shape without knowing which client it is talking to. That contract —
`denyOutcome()` / `injectOutcome()` — is documented in
[ADAPTER_AUTHORING.md](ADAPTER_AUTHORING.md#response-contracts-do-not-port).

## Installation is not uniform either

| | codex | claude_code | gemini_cli | grok | kimi |
|---|---|---|---|---|---|
| Where hooks live | marketplace plugin | plugin | `settings.json` | `~/.grok/hooks/acc.json` | `config.toml` |
| Project-level config | no | no | yes | yes (`<project>/.grok/hooks`, unused) | **no** |
| Hook `timeout` unit | - | - | milliseconds | **seconds** | **seconds** (max 600) |
| Command path | absolute required | `${CLAUDE_PLUGIN_ROOT}` | absolute required | absolute required | absolute required |
| Extra step by the user | hook trust | - | - | - | - |

Kimi Code is the only one with no project-level config, so ACC edits the user's global
`config.toml` — as a delimited block it owns, because ACC ships without dependencies and a
hand-written TOML round-tripper would take the user's comments and formatting with it.

Codex needs four things before a hook runs, not one: the plugin directory, a parseable
marketplace, both `[marketplaces.…]` and `[plugins."…"]` registered in its config, and the
plugin copied into `plugins/cache/<marketplace>/<plugin>/<version>/`. ACC does all four —
that last copy is exactly and only what `codex plugin add` does, measured by diffing the
home around it. Hook trust remains a manual step, which is the client's security model.

## What a participant declares about itself

Every session records `enforcement` (`guarded` | `advisory`) and `lifecycle`
(`managed` | `manual`), taken from the adapter's proven capabilities in this matrix rather
than from the harness's name — both default to the weaker reading, so a generic MCP client
or a human at the CLI reads as advisory and manual. What that downgrade means for a
workspace, and why one MCP participant in the room is enough to drop everyone else's
protection, is explained canonically in
[MCP.md](MCP.md#native-adapter-vs-mcp-client).

**"Stoppable" is not "unevadable".** Even in a guarded workspace, a session that writes
through a language runtime rather than a recognised shell form gets past — see
`guards.beforeShell` above. The claim still says who is working where; enforcement is the
floor, not the ceiling.

---

See also: [README](index.md) for navigation, [Glossary](GLOSSARY.md) for terms,
[Adapter authoring](ADAPTER_AUTHORING.md) for the deny/inject implementation contract, and
[MCP](MCP.md) for the participation tier and the native-vs-MCP explanation.
