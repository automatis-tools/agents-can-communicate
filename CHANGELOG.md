# Changelog

## Unreleased

| | |
|---|---|
| Built from | `621bab2` |
| Tarball | `agents-can-communicate-0.1.1.tgz`, 129 KB, 107 entries |
| sha256 | `04d058e2e2b099a38eb27342335480438ee0bf1a43836787c31a44ce17263eab` |
| Tests | 837 passing, 0 failing |

Not published. A published record says what the registry serves and is not
rewritten, so shipped code that changes after a release is measured here instead.

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
