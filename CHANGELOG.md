# Changelog

## Unreleased

| | |
|---|---|
| Built from | `5fb3cfd` |
| Tarball | `agents-can-communicate-0.1.5.tgz`, 135 KB, 109 entries |
| sha256 | `98995091e8d17f8ec34f84246f4f993e663d036a6ebeb24e938db8946944d09d` |
| Tests | 879 passing, 0 failing |

Not published. A published record says what the registry serves and is not
rewritten, so shipped code that changes after a release is measured here instead.

Every binary the manifest declares is executable in the repository.
`bin/acc-hook.mjs` was not, while its two siblings were. npm sets the bit when
it links a `bin`, so the difference was invisible - until `npm install -g .`
set it and left the working tree dirty, which is how it was noticed.

An agent in Codex can record what it is doing. That client sandboxes the shell
commands a model runs to the workspace, and ACC keeps its state outside every
workspace on purpose - so an agent there could read the roster and write
nothing: `acc claim`, `acc work` and `acc message` each failed with
`EPERM ... locks/writer.lock`. Half the product, silently, for one of four
clients.

The install declares that directory writable in the block it already owns. A
config that sets `sandbox_workspace_write` itself is left alone - declaring the
table twice is what makes this client refuse the whole config - and the
diagnostic says what to add instead.

Measured with `codex exec`, which is how an agent actually runs: the same
command that failed with EPERM now returns `intent: reviewing the parser` and
exit 0, with no flags passed by hand.

## Unreleased

Not published. Documentation only; the packed tarball is unchanged, so the
record below still describes it.

`docs/CLI.md` names the condition on the promise it makes. It said an agent can
close its terminal and the next session it opens is still told - true only when
that agent has a name of its own. Without one, each run is a new participant and
nothing addressed to the last one reaches it. `docs/PROTOCOL.md` had said so all
along; the document a reader acts from had not.

Seen while running two real clients against one workspace: consecutive runs
appeared as `kimi-5P8POZ`, then `kimi-qUW4ei`.

## Unreleased

| | |
|---|---|
| Built from | `f0100c9` |
| Tarball | `agents-can-communicate-0.1.5.tgz`, 135 KB, 109 entries |
| sha256 | `24ce109ae1928fde21ab22bf89f42bff35b2b20add7e089b7eab6a283534a1c1` |
| Tests | 880 passing, 0 failing |

Not published. A published record says what the registry serves and is not
rewritten, so shipped code that changes after a release is measured here instead.

`acc status` says when the sessions it counts are not answering. `live` means
present rather than online - a client that exits without closing its session
leaves a record that goes stale rather than disappearing - so the line read
`1 live` about a workspace whose only agent had left minutes before. The data
was right the whole time: the same call reported `presence: stale` and
`counts.stale: 1`. The sentence a person reads was the part that was not.

Found by running a real client and watching what it left behind: a short run
closes its session on the way out, and a longer one does not always get that
far.

## 0.1.5

One fix, and the most serious so far: every published version taught agents a
command that could not run. `0.1.0` through `0.1.4` are affected.

| | |
|---|---|
| Built from | `479b240` |
| Tarball | `agents-can-communicate-0.1.5.tgz`, 135 KB, 109 entries |
| sha256 | `5022560495d527fec8e37cf2ba9ea37ff4df3dcbafa2bef468f22108c7e925f5` |
| Tests | 872 passing, 0 failing |
| Node | 24 (current production LTS) |
| Verified on | macOS 15 (darwin 25.5.0, arm64) and Linux in CI |
| Not supported | Windows — untested rather than known-broken |

The skill every agent is given names a command that runs. It named
`<package>/node_modules/bin/acc.mjs`, which does not exist, so an agent that
followed the skill got `MODULE_NOT_FOUND` - in every client, on every install
from the registry.

The path was counted out in `../` from the SDK's own directory, which is right
in a development checkout and one level shallow once the workspaces are bundled.
That was found once for the hook runner and fixed for the runner alone; the CLI
kept the count. Both are found by walking up now, through one function, so the
next binary cannot inherit the count. The packaging test checks the installed
layout for both rather than for the runner alone.

Found by asking a real Claude Code session to edit a file another agent had
claimed. The guard refused it, and the agent said so - and reported, on the way,
that the command in the skill had failed and that it had gone looking for the
real one.

## 0.1.4

The public documentation rewritten around what a reader is trying to do, and one
trap closed - found while configuring an MCP client during an end-to-end run and
wondering where everybody had gone.

| | |
|---|---|
| Built from | `508795e` |
| Tarball | `agents-can-communicate-0.1.4.tgz`, 135 KB, 109 entries |
| sha256 | `bb210f6b88ba150bba6c9238600bb4677e1446e5f7b8dd61f812fcbd95c373a9` |
| Tests | 872 passing, 0 failing |
| Node | 24 (current production LTS) |
| Verified on | macOS 15 (darwin 25.5.0, arm64) and Linux in CI |
| Not supported | Windows — untested rather than known-broken |

Public documentation now tells ACC's story from the user's problem: opening more agent
sessions should let those sessions carry coordination while the human focuses on the
work. The README follows a handoff in plain language, gives the required installation and
activation commands, explains where ACC runs and stores its state, and focuses the rest
of the journey on visible outcomes and supported scope. Protocol output, internal
delivery states, architecture wiring, and detailed capability matrices live in the
reference guides. The promises use affirmative language about local operation, client
ownership, private transcripts, and supported scope. Mermaid diagrams show the human
setting direction and agents carrying a handoff through ACC's shared room.

`acc-mcp` refuses arguments instead of ignoring them. It reads nothing from the
command line, and accepted anything: writing `acc-mcp --cwd <project>` - the
habit `acc` teaches - started a server rooted wherever the client happened to
launch it, alone in a workspace nobody else was in, saying nothing. It now names
the two variables that configure it and exits 2.

Every variable the code reads from the environment is written down. Four were
not, and one of them - `ACC_MCP_WORKSPACE` - decides which project an MCP client
joins. A test scans what is read from `env` and fails on anything no document
mentions; the shim's own `ACC_NODE` and `ACC_RUNNER` are shell variables of its
own, not configuration, and are outside it.

## 0.1.3

Two of them broke a promise in silence, and both were found by installing 0.1.2
and using it rather than by running the tests again: an install this client
reported as not installed, and a message that told the reader nothing.

| | |
|---|---|
| Built from | `8679ae8` |
| Tarball | `agents-can-communicate-0.1.3.tgz`, 135 KB, 109 entries |
| sha256 | `b3821785071c578a5198d869c2dfb03c25226c34a14a8669ba8882f153477c6d` |
| Tests | 868 passing, 0 failing |
| Node | 24 (current production LTS) |
| Verified on | macOS 15 (darwin 25.5.0, arm64) and Linux in CI |
| Not supported | Windows — untested rather than known-broken |

Running `acc` in a home directory says what is wrong with that. A home is no
checkout, so discovery falls back to the directory you are standing in - and the
platform's own state directory is inside a home by definition, so every command
that opens a workspace refused with "runtime state must not live inside the
workspace". True, and written for somebody who had put the state in a project on
purpose. It names the directory, the state it holds, and the two ways out now.

The Codex install is an install. `acc install` reported success for this client
and `codex plugin list` said `not installed`, which is the failure the adapter's
own doc-comment warns about: placing files is not installing.

Three things were wrong, and one root cause. ACC wrote into
`<home>/.agents/plugins/marketplace.json` - the marketplace this client
discovers by itself, with no config entry at all, under whatever that manifest
calls itself. So ACC was a guest in somebody else's marketplace while naming its
own: it enabled `agents-can-communicate@acc-local`, an id this client never
forms; it cached the plugin under `acc-local` while the client looks under the
marketplace's real name; and it placed the tree relative to the manifest's
directory while this client resolves `./plugins/<name>` against the marketplace
root.

ACC registers a marketplace of its own now, rooted at `<home>/.agents/acc-local`
- its own name, its own manifest, its own cache directory, and the user's
marketplace untouched. Under `.agents/` rather than the home itself, because the
root is what `./plugins/<name>` resolves against and nothing of ACC's belongs at
the top of somebody's home.

Measured against Codex 0.147.0 throughout, including the fix: `codex plugin
list` reports `agents-can-communicate@acc-local  installed, enabled  0.1.2`, and
after `acc uninstall` reports nothing and leaves the directories gone.

Uninstall no longer removes a directory it shares. While ACC was a guest, the
cache root it deleted was the marketplace's - and it took a plugin the user had
installed themselves. Found by doing it to a real machine. ACC owns its own
marketplace again, and removes its own plugin from the cache rather than the
directory above it; the ownership hashes had already refused to delete the
shared one on the run after, which is what made it visible.

## 0.1.2

Six defects, and not one of them came out of running the tests again. Three
questions found them: what a person needs `--dry-run` for, whether there is an
auto-updater, and what happens when a version manager moves node. Each answer
turned out to be that something was already broken and saying nothing about it.

| | |
|---|---|
| Built from | `200b847` |
| Tarball | `agents-can-communicate-0.1.2.tgz`, 134 KB, 109 entries |
| sha256 | `c0103bd03f157308db30b30deaf29180df7c67086f873e293d2b8d52b3167d5c` |
| Tests | 861 passing, 0 failing |
| Node | 24 (current production LTS) |
| Verified on | macOS 15 (darwin 25.5.0, arm64) and Linux in CI |
| Not supported | Windows — untested rather than known-broken |

`acc update` asks npm whether there is a newer ACC, and `--apply` installs it and
re-runs `acc install`. An upgrade lands in two places: `npm install -g` replaces
the CLI and the hook runtime - a client runs the runtime out of the npm directory
rather than a copy - and leaves the bundle written into that client alone,
including the skills the agents read. Measured: after an upgrade the client still
had `0.1.0` while `acc --version` said `0.1.1`, and doctor called it healthy.

`acc doctor` now says so. The install record carries the ACC that wrote it, and a
client wired to an older one is named with the command that fixes it. Nothing is
said when the record predates the field: "your plugin might be old" on every run
is not a diagnosis.

`acc doctor` also prints its remediation. It computed a list of what to run next,
put it in the data, and printed a one-line summary - so the command documented as
saying "what to run next" said it only to `--json`. There were no tests for this
command at all.

The update check is the only part of ACC that reaches the network, and it is
kept to one file. `acc update` asks; `acc doctor` reads what that remembered and
asks at most once a day; `ACC_NO_UPDATE_CHECK=1` turns both off and then says it
is off rather than reporting that nothing is newer. Nothing on the hook path
asks, which a test enforces by scanning every package a turn loads: a hook runs
each turn inside a five-second budget and fails open, so a stalled socket there
would be invisible by design.

`ACC_PROBE_TIMEOUT_MS` raises how long detection waits for a client to print its
version. Three seconds is generous on an idle machine and not always enough on a
busy one, where a cold start that overruns it makes an installed client look
absent and the installer skips it saying so.

The hook shim survives the node it was written for. Its paths are pinned on
purpose - a hook runs with an environment that may carry neither PATH nor a shell
profile - but the pinned pair moves: a version manager changes the interpreter
and the directory global packages live in, and the shim then failed on every
event with exit 126 and an empty stdout. No presence, no claims, no messages, and
nothing anywhere saying why. Measured, then fixed: the pinned pair is still tried
first, then `acc-hook` as npm links it - and only when node is on PATH, since
its shebang is `env node` and an `exec` that fails ends the shim where it stands,
which the release check caught as exit 127 in place of the line that says what to
do - then the current node against the recorded runtime. With nothing left to run it says which path is gone and how to
re-wire, and exits 0 - hooks fail open, and a broken install is not a reason for
somebody's session to stop working.

`acc install` says what it wrote. `installed 3 adapter(s)` was the whole account
of a command that had just written into three other tools' configuration inside
someone's home; the list existed all along, since `--dry-run` prints it, and the
run that did the work printed a number. An uninstall says what it removed and
what it held back, which is decided while it runs: bytes that stopped matching
what ACC wrote are someone's, and are kept.

`--yes` is gone from `acc install` and `acc uninstall`. Neither has ever asked
anything, and the flag was read by no code at all - a promise that a
confirmation exists to be skipped. It stays on `acc config init`, which does ask.

`acc config init` can be answered. It had the code to ask, but no confirmation
port was ever handed to it, so the question went to a fallback that always
answered no: in a real terminal the command printed `not written` and never said
why, and `--yes` - documented for runs with nobody to ask - was the only way to
write the file. Verified against a pseudo-terminal: `y` writes, `n` does not,
and closing the input is a refusal rather than an error. A build assembled
without a way to ask now says so instead of declining on the reader's behalf.

The README leads with `acc install` rather than `acc install --dry-run`. The
preview is for scripts, for CI, and for anyone who wants to look first - not the
first thing a person should have to run to install something.

One test raced the clock. `the owner is told when its claim runs out` took a
two-second lease, then asserted the expiry was not reported yet; under a loaded
suite the turn began after the lease had already lapsed. The two halves hold
separate leases now.

## 0.1.1

Four defects that 0.1.0 shipped with, all of them found by installing the
published tarball and using it rather than by running the tests again. Every one
of them survived because everything was green: the tests knew which command to
run, the record's own gate watched the wrong set of files, an uninstall was
planned from the wrong source, and the byte-for-byte claim was proved on a
different file format than the one that broke it.

| | |
|---|---|
| Built from | `de01634` |
| Tarball | `agents-can-communicate-0.1.1.tgz`, 127 KB, 106 entries |
| sha256 | `fbe2c3e0f169159af447e3a48428181b77e0cc89acbf3da5884d33db78a8bda7` |
| Tests | 828 passing, 0 failing |
| Node | 24 (current production LTS) |
| Verified on | macOS 15 (darwin 25.5.0, arm64) and Linux in CI |
| Not supported | Windows — untested rather than known-broken |

`acc --version` and `acc help` answer. Neither existed: the first two things a
person types after installing from a registry were both "unknown command", and
`acc` on its own asked for a command without naming one. The list is generated
from the command table, so a command that exists is always listed.

A config ACC edits is edited rather than reprinted. Reading the style back out
of the file kept the indentation and still reformatted what the style could not
describe: a nested object written on one line came back as three, and a blank
line between sections was gone. Unchanged values are copied across verbatim now,
so the byte-for-byte round trip the security tests have claimed since before
this - and proved on `config.toml` - holds for JSON as well.

Reading a config with a `__proto__` key set the prototype of the object being
built instead of adding a key to it, so the key vanished from what was read.

An install could not be removed once its client left the machine. `acc
uninstall` skipped exactly the client ACC had written to, reported success, and
said the same thing on every run afterwards - leaving ACC's tree in the client's
configuration directory and ACC's entries in the user's own settings file. The
plan was built from detection; it is built from the installation record as well
now, which is the only account of what was written.

`uninstalled N adapter(s)` counted every adapter whose uninstall ran, which on a
machine ACC had never touched was all of them. It counts the ones it changed.

`--dry-run` works on `acc uninstall`. The preview was computed for either action
from the start and only `install` had a flag to ask for it.

`package.json` is shipped code: npm packs the manifest whatever `files` says.
It was not in the set the record's own test watches, so editing the manifest
changed the digest while every gate stayed green. The set is asked of `npm pack
--dry-run` now rather than copied by hand, and any path that reaches the tarball
unwatched fails by name.

The manifest itself carries `npm pkg fix`: npm rewrote `./bin/acc.mjs` to
`bin/acc.mjs` in the registry metadata on every publish and warned about it. The
tarball was never affected.

## 0.1.0 — first release

Published to npm. `0.x` because the surfaces are young: several of them changed
in the week before this, and a version that promised otherwise would be the first
thing in here that was not measured.

| | |
|---|---|
| Built from | `c318458`, published from `b428ca7` — the merge changed nothing packed |
| Tarball | `agents-can-communicate-0.1.0.tgz`, 123 KB, 105 entries |
| sha256 | `e4ed773feb25dd40a0fb5d2bb010f66261613a3cac14882750b431f3ab2a3480` |
| Tests | 808 passing, 0 failing |
| Node | 24 (current production LTS) |
| Verified on | macOS 15 (darwin 25.5.0, arm64) and Linux in CI |
| Not supported | Windows — see below |

This is a measurement, not a promise about `main`. Every workspace travels inside the
tarball, so any change to shipped code changes the digest — and the commit named above is
necessarily an ancestor of the one recording it, because no commit can contain its own
hash. Only `bin/`, `README.md`, `LICENSE`, `docs/CAPABILITIES.md`, and the workspaces are
packed, so changes to tests, scripts, or the rest of `docs/` leave the digest alone.

The registry serves that digest. Checked after publishing by downloading the
tarball back rather than by trusting the local pack:

```bash
curl -sSL -O "$(npm view agents-can-communicate dist.tarball)"
shasum -a 256 agents-can-communicate-0.1.0.tgz
```

To check it, or to record a newer candidate:

```bash
node scripts/verify-package.mjs
```

It prints the digest and the revision on one line, and refuses to imply reproducibility
when the working tree is dirty.

### What it does

Coordinates independent agent sessions in one workspace: presence, intent,
workspace-global claims, typed messages, handoffs. No session is in charge.

`acc install` works from a published package, and says so when it does not. The
hook runner was located by counting directories up from the SDK, which is right
in a development checkout and one level short once the workspaces are bundled —
so every install refused, for every client, from a clean install of the package.
Nothing caught it: the command counted its failures in a line beginning with a
success, exited 0, and the release check threw that output away.

`acc status` lists who is here. Closed sessions are kept — the roster is the only
place that answers which checkout an agent was working in — and `acc status --all`
is how a worktree cleanup asks for them.

`acc doctor` works on a store nobody can read, which is the only store worth
running it on. One truncated record used to make it answer "invalid JSON record"
and name nothing, while the diagnosis it had already built was thrown away.

A hook killed by its client no longer takes the workspace down with it. Every
client puts a timeout on hooks; one killed mid-write used to leave the writer
lock behind and stop every write for the next sixty seconds — silently, since
hooks fail open and the session simply never appeared.

An agent that asked and got no answer is told so. Work that stalls and a question
nobody is left to answer raise the same attention item, because they are the same
fact: you asked, and there is nobody there.

Every line of an injected turn can be acted on. An attention line carries the id
of the thing it is about — the same id the command that answers it takes — and a
turn the byte budget truncated says how to read what it withheld.

A cursor that is not a cursor is refused, and so is a scope that is not a scope —
`--scope ful` used to answer the one question the full scope exists for with a
delta carrying no snapshot.

A cursor that is not a cursor is refused. It used to answer "nothing new" every
time, for as long as it was held, so a corrupt one looked exactly like a quiet
workspace.

A session that is working looks alive. Only one of the four clients fires a
heartbeat event, so every other session went stale three minutes after starting
and stayed stale — every roster said so of every peer, and a requester was told
"nobody is working on it" about work being done right then.

An agent is told when the claim it is relying on has run out. The lease lapsed on
the clock, peers could write again, and the holder's turn said nothing — it went
on working on a file it believed it had reserved.

A decision can be recorded. The protocol has described the object from the start
and nothing could make one; the rule that an agent cannot record a human decision
by itself is now reachable rather than only implemented. Every core operation has
a surface — the register of "tracked, not forgotten" is empty.

An open workstream can be taken on. Creating one used to put
`coordinator_missing` in every turn from then on with no way to answer it: the
two operations that do had no command and no tool.

A handoff reaches the agent it hands over to. `acc finish --to physics` wrote a
durable record that nothing in the codebase read: not the successor's turn, not
their attention, not `acc status`.

A peer nobody has ever been cannot be addressed, nor assigned to. `acc message --to physcis` used
to answer "sent", and `acc request` made a task assigned to nobody that its
requester then waited on. The refusal names who is here, and it bounds the
recipient list by construction — one message naming three thousand participants
took 24.8 seconds and left every session in that workspace paying five to attach
and take a turn.

Agents that start at the same time in a workspace none of them has opened all get
in. Three of four used to fail: the identity document each writes first carries
the moment it was written, and materialisation asked whether it was needed before
taking the lock that would have answered.

An MCP client is handed its messages by `acc_sync`, body and all, and its receipts
move — it had only ever seen a subject line, and the sender was told its message
was undelivered by an agent that had answered it.

A peer's message reaches the recipient's turn as a fenced, attributed, escaped
block, and its receipt advances to `injected` only for what the turn actually
carried — a message the context budget could not fit stays queued rather than
telling the sender it landed. The ceiling is `policy.contextBudgetBytes`.

Claims are enforced however the workspace path is spelled, and wherever the
client starts its hooks. A project reached through a symlink — `/tmp` and `/var`
on macOS, a symlinked checkout anywhere — used to pass every write through while
still reporting `protection guarded`. So did a relative target when the hook
process began somewhere other than the session's own directory, and so did a file
named from a subdirectory of the project, which gave one file two names. A claim
taken in one worktree stops a write in another worktree of the same repository.

An agent can run the commands its skill teaches. Every mutating command took a
session id and a generation on the command line, and the skills told agents to
pass two environment variables nothing has ever set — so on all four native
clients the documented workflow could not be carried out at all. `acc` now works
out which session is running it, and stops rather than guessing when two live
sessions in one checkout both fit.

`acc config init` refuses while sessions are attached. The config carries the
workspace identity, so writing one moved the project to a different workspace and
left every running session heartbeating the old one, invisible to everyone and
not recovering until its client restarted.

Installing edits configuration for four other tools, and every one of their homes
comes back as it was found — including a home that had none of those files, which
is left with none of them — byte for byte, with nothing left behind and nothing
reformatted. Uninstall removes the entries ACC recorded writing and nothing else. A settings key ACC had to create
goes only when it is empty: plugins the user enabled afterwards live in that same
key, and taking it outright took them too.

### Clients

| Client | Version | Attach | Guard writes | Inject | Heartbeat |
|---|---|---|---|---|---|
| Codex | 0.147.0 | yes | yes¹ | yes | – |
| Claude Code | 2.1.233 | yes | yes | yes | – |
| Gemini CLI | 0.37.0, 0.55.1 | yes | yes² | yes | – |
| Kimi Code | 0.36.1 | yes | yes | yes | yes (60s) |
| Any MCP client | rev 2026-07-28 | yes | – | – | – |

A live model completed the full request loop on Codex - one session found who
owned the work, asked for it, and the other took it, fixed the code and reported
back. Claude Code attaches by itself and its agent used ACC's commands from the
skill. Kimi Code fired every hook and its model never ran: the account's quota is
spent. Gemini CLI fired every hook and its model never ran either: the account
returns a permission error in headless mode.

¹ only models that offer `apply_patch`; others edit through the shell, which
names no resource · ² only approval modes that expose edit tools

Full matrix and what the `yes` values do **not** promise:
[docs/CAPABILITIES.md](docs/CAPABILITIES.md).

### Known limitations

- **Kimi Code fires no `SessionEnd`.** Prompt-mode sessions age out on their 60s
  cadence, so a roster read inside that window shows sessions that have exited.
- **Codex needs hook trust.** ACC completes the install; trusting the plugin is
  the client's own step.
- **No shell guard is resource-aware.** A command names no path, so a claim
  cannot be matched against it. The turn context says so instead.
- **One unguardable participant makes the workspace advisory.** An MCP client or
  a shell-editing model means a guarded claim is advice, and status reports that.
- **Gemini headless returns 403 on the account used here.** Not ACC's doing —
  reproduced with a plain `gemini -p` outside ACC entirely. Headless runs also
  need `GEMINI_CLI_TRUST_WORKSPACE=true`.
- **No live model has driven Kimi Code or Gemini CLI.** Both fire every hook
  against the real client; neither account can complete a turn. Their matrix rows
  rest on hook captures, not on a finished exchange.
- **No subagent visibility.** `lifecycle.childSessions` is false everywhere; no
  subagent was observed during capture.
- **Windows does not work.** Not "untested" — measured. Once CI actually ran the
  suite there, 86 of 587 tests failed. Two root causes so far: the store fsyncs a
  directory after a rename for durability, which Windows refuses with `EPERM`,
  and `O_NOFOLLOW` does not refuse a symlinked config the way it does on POSIX —
  so the symlink defence does not hold. macOS and Linux are supported; Windows
  is future work.
- **Nothing retires a closed session.** One record per session, kept forever. A
  message now carries the participant that sent it, so attribution no longer
  depends on the record surviving — which was the thing preventing retirement.
  How much history a project keeps is that project's decision, and no policy is
  imposed here.
- **A turn still costs more in a busy workspace.** Attaching and heartbeating are
  bounded by what is live, and the write guard is too. Building a turn is not: it
  has to know which messages are pending for you, and messages are the kind that
  grows. Measured against 900 records, `beforeTurn` took 693ms against a floor of
  88ms. Fine for a project's worth of coordination, not for an archive, and
  nothing prunes yet.
- **Client capabilities were certified on macOS only.** Linux runs the suite in
  CI, but no adapter was exercised against a real client there.

### Not included

Remote coordination, process launching, push delivery, wake-on-message. All out
of scope for the first release.

### Before publishing

See [docs/RELEASING.md](docs/RELEASING.md). Publication, tagging, and a GitHub
release are deliberate acts and need explicit approval.
