# Changelog

## 0.1.17

A peer message no longer starves behind a standing reminder. The turn a client
injects put messages last, so a reminder about your own lapsed claim could hide
a decision a peer sent you - which is exactly what happened to two agents.

| | |
|---|---|
| Built from | `PENDING` |
| Tarball | `PENDING` |
| sha256 | `PENDING` |
| Node | 24 (current production LTS) |
| Verified on | macOS 26.6.2 (darwin 25.6.0, arm64) and Linux in CI |
| Not supported | Windows - untested rather than known-broken |

A peer message no longer starves behind a standing reminder. The turn projector
placed messages last, after all attention, so a `claim_expired` reminder - which
regenerates from state every turn and never clears - permanently pushed a
one-time message into the over-budget overflow. Two agents each lost their most
important message there: a decision that unblocked one, a numbering collision for
the other. Messages now sit after "act now" attention (`direct_request`,
`claim_conflict`) and ahead of standing reminders, and a dropped message gets its
own loud line instead of the plain "+N not shown" both agents read as noise. The
note is guarded against the budget, closing a latent overrun the longer line
exposed. The skill teaches the loud line as an imperative: pull before you
conclude you are blocked on a peer - the answer may already be queued.

## 0.1.16

`acc doctor` tells the truth about what an upgrade left stale: the skills copied
into a client, not the hook runtime, which `npm install -g` already refreshed.

| | |
|---|---|
| Built from | `0b75f4e` |
| Tarball | `agents-can-communicate-0.1.16.tgz`, 154 KB, 114 entries |
| sha256 | `098a8f48c96718c64e348ebe6d71803f513bf5dc1413ab0fc9996ffe8a43a93e` |
| Node | 24 (current production LTS) |
| Verified on | macOS 26.6.2 (darwin 25.6.0, arm64) and Linux in CI |
| Not supported | Windows - untested rather than known-broken |

`acc doctor` names the stale bundle, not the runtime. After `npm install -g` with
no `acc install`, the client's shim points into the npm directory, so the hook
runtime is already current while the skills and manifests copied into the client
are from whatever acc last installed them. Doctor called that "plugin is <old>",
which reads as a stale runtime and contradicts the `wired` field that shows the
runtime is current. The remediation now names the skills and manifests, and a new
`bundleVersion` field carries the acc that wrote them, beside `wired` for the
runner - the two diverge only after an npm upgrade, and reporting both makes the
divergence legible.

## 0.1.15

Intent finally points at the peer it names. Its one machine-read field now drives a
rule that faces the claim holder rather than only the agent declaring intent, and the
skill teaches the field that feeds it.

| | |
|---|---|
| Built from | `55bcb64` |
| Tarball | `agents-can-communicate-0.1.15.tgz`, 154 KB, 114 entries |
| sha256 | `8a7bb11d1e34681aa41613dcfedf5ca5e74850735c011161eda4b659a01bf742` |
| Node | 24 (current production LTS) |
| Verified on | macOS 26.6.2 (darwin 25.6.0, arm64) and Linux in CI |
| Not supported | Windows - untested rather than known-broken |

Intent gains a reader that faces the other way. `claim_conflict` has always warned
the agent declaring intent that its target is already claimed; nothing warned the
claim holder. A new attention rule, `claim_contended`, closes that: when a peer's
declared resource hints overlap a claim you hold, you are told - early, because a
claim is advice, not a lock. Only your own claims, and never your own intent
against them.

The skill now teaches `--hint`. It taught `--summary` and `--mode` and left out the
one field a peer's tools act on, so agents filled what a person reads and left empty
what a tool can match. A summary is not a hint.

## 0.1.14

Sessions that ended without saying so no longer haunt the roster. A client killed
with its terminal, or one that has no session-end event at all, left a record open
forever - one real workspace had accumulated 227 of them, and `acc doctor` reported
the pile as a fault. Upgrading requires deleting the store; there is no migration,
and ACC now says so plainly instead of failing three different ways.

| | |
|---|---|
| Built from | `0badbe8` |
| Tarball | `agents-can-communicate-0.1.14.tgz`, 153 KB, 114 entries |
| sha256 | `b5ee8e088a2ac6f734706e3da757ef9385cb2dbaee61641bcaa8e924af292e00` |
| Node | 24 (current production LTS) |
| Verified on | macOS 26.6.2 (darwin 25.6.0, arm64) and Linux in CI |
| Not supported | Windows - untested rather than known-broken |
| Pid resolution | `codex` and `claude_code` only; `gemini_cli` and `kimi` run through an interpreter, so they fall back to the age floor. See [CAPABILITIES.md](docs/CAPABILITIES.md) |

A session whose process is gone now says so. A record is opened by a hook at
session start and closed by one at session end, and when a client never fires the
second - it has no such event, or it was killed with its terminal - the record
stayed open forever. Presence decayed to `stale` and stopped there, because
nothing could ask whether the process still existed. One real workspace had
accumulated 227 of them, and `acc doctor` reported the pile as "not answering",
which reads as a fault and is not one.

Presence now pairs the process with two floors, the way the writer lock already
reclaims a lock that is dead *and* old. A hook records the client's pid once, at
session start, walking the process ancestry until it finds the binary its own
adapter declares - the hook is not the client's child, and a shell usually sits
between them. A pid confirmed dead makes the session `offline` at once. A pid
nobody could name is judged by silence instead, at thirty minutes. Twenty-four
hours retires a session whatever its pid says, because pids are recycled and a
dead session's number can come back attached to something unrelated.

`null` is a first-class answer here, not a missing value. No process table on this
platform, or an ancestry that did not resolve, means nobody knows - and nobody
knows is never read as dead.

Nothing is written back to the record. `acc status --all` still lists everyone who
was ever here, and presence stays a reading rather than an edit.

Replacing a session id is held to the stricter test. A wrong presence verdict
costs a roster row and corrects itself the moment that session next takes a turn;
a wrong replacement takes a live session's generation, and from then on the
original session's own heartbeats fail with exit 5. Nothing undoes that. So only a
pid confirmed dead is authority to replace an id. Silence, however long, is not.

`SCHEMA_VERSION` is 2, for the session record's new field, and `STORE_VERSION` moves
with it: a store written by an older ACC is refused before a single record is read,
with one plain `unknown store version` error, rather than opening the store, letting
`acc status` appear to work, and only then breaking - `heartbeatSession` throwing deep
inside on `unknown schemaVersion: 1`, `acc doctor` filing every record in the store
under `corrupt`. Three confusing symptoms become one clear one. There is still no
migration: the fix for an old store is the same as before - delete it and let ACC
create a fresh one.

## 0.1.13

One fix, and it is the reason to upgrade off 0.1.12 rather than wait. Two agents
starting in the same fresh workspace at the same moment - the ordinary way people
begin work - could leave one of them refused, and under a hook that refusal is
silent: the session simply never appears.

| | |
|---|---|
| Built from | `8ef19b9` |
| Tarball | `agents-can-communicate-0.1.13.tgz`, 148 KB, 111 entries |
| sha256 | `13748bcbd3b0262b1c7ce6418ecb5e41290d0ceea39e243c5df16e6f159da86a` |
| Node | 24 (current production LTS) |
| Verified on | macOS 15 (darwin 25.5.0, arm64) and Linux in CI |
| Not supported | Windows — untested rather than known-broken |

A lock changing hands is not an attack. Reads inside the store are guarded
against a directory being swapped between the check and the open: stat the
parent, open with `O_NOFOLLOW`, stat the parent again, refuse if its identity
changed. That is right for a record - a state file's parent has no business
being replaced while it is read.

The writer lock is the one directory in the store whose entire life is being
created and removed. `mkdir` is the atomic primitive that grants it and `rm` is
how it is released, so its inode changes every time the lock passes from one
process to the next. The owner file lives inside it and was read through the
same strict path, so a contended lock produced:

```
record parent directory changed while opening
```

and the command failed outright. Two agents attaching to a fresh workspace at
the same moment - the ordinary way people start work - and one of them simply
does not join.

Reading the owner now treats that as what it is: the lock moved. Both callers
already do the right thing with that answer. The acquiring loop waits and looks
again; the releasing branch declines to remove a directory that is no longer the
one it created. The guard itself is untouched and still refuses everywhere a
parent has no business changing, which a test holds in place.

Found by CI on Linux, on the merge commit of 0.1.12 - the same code having
passed the same job on the pull request minutes earlier. Twelve rounds of six
concurrent agents on macOS never reproduced it, which is how it reached a
release. The test that holds it now does not depend on timing at all: it hands
the lock to another holder in the window between the two checks, through the
opener seam the other race tests already use.

## 0.1.12

Two fixes for machines this project had never actually looked at. Every
end-to-end run until now was done on one carrying all four clients and a healthy
store, so a machine with fewer clients - or a store that cannot be read - was
territory nobody had walked.

| | |
|---|---|
| Built from | `93ea98b` |
| Tarball | `agents-can-communicate-0.1.12.tgz`, 148 KB, 111 entries |
| sha256 | `df1d0f07619eecffb17f7616a3713037a155778714d650ec411c84441079b947` |
| Node | 24 (current production LTS) |
| Verified on | macOS 15 (darwin 25.5.0, arm64) and Linux in CI |
| Not supported | Windows — untested rather than known-broken |

`acc doctor` runs on the store it exists to diagnose. This was fixed once
already, and the throw moved rather than went away. The first time, `collectStatus`
read every record before the diagnosis and died on a truncated file, so the
command answered `invalid JSON record` while the inspection had already found the
file and put it in a list nobody saw. `runDoctor` was taught to check the report
first.

But every command outside a short list opens the store before its handler is
called, and `doctor` was not on that list. So the diagnosis still died - one
frame earlier, in the setup, before any of the code written to report it ran:

```
$ acc doctor --cwd <project>
invalid JSON record: …/workspaces/workspace_662a…/protocol.json
```

One line, no framing, no list, no remedy. `--repair` did the same, instead of
saying that repair is blocked - which is exactly what it is designed to say, and
for a good reason it already carries: *completing a journal on top of state we
cannot even read would turn an ambiguous store into a confidently wrong one.*

Locating a workspace and opening it are separate now. `doctor` gets a context
that knows where the store is and opens it on request, after the report has said
that reading is safe:

```
store state is ambiguous; repair is blocked. 1 unreadable:
  …/workspaces/workspace_02407733…/protocol.json
```

Splitting them exposed a case the old order had been hiding: opening the store
created it, so the inspection never met a store that does not exist yet. Reading
the report first, "no protocol.json" looked exactly like "unreadable
protocol.json", and a person's first `acc doctor` in a new project would have
been told their store was broken. Absent and unreadable are now different things.

## Unreleased

| | |
|---|---|
| Built from | `5b2e66f` |
| Tarball | `agents-can-communicate-0.1.11.tgz`, 147 KB, 111 entries |
| sha256 | `b3b35a86bfc62a48ba054b0fff780299454a94ff7d5a31ed8824630817c6b2e7` |

Not published. A published record says what the registry serves and is not
rewritten, so shipped code that changes after a release is measured here instead.

An install that wired nothing says what still works. Every end-to-end run until
now was done on a machine carrying all four clients, so the machine that carries
one - or none - had never been looked at. On that machine `acc install` said:

```
installed 0 adapter(s)
  skip claude_code: Claude Code is not installed on this machine; …
  skip codex: Codex CLI is not installed on this machine; …
  skip gemini_cli: …
  skip kimi: …
```

Every line true, and together they read as "ACC has nothing for you". They are
wrong about that: the MCP server needs no adapter at all. Measured on exactly
such a machine - no client binary on PATH, a fresh home - `acc-mcp` answered
`tools/list` with ten tools and `acc_work` wrote an intent into the store.

Both `acc install` and `acc doctor` now name that path, and only when nothing was
wired. The skips already carry their own remedy, `0 of 4 adapter(s) installed`
would otherwise read as a broken machine on every run an MCP-only user makes, and
a line printed every time is a line that stops being read. An uninstall that
removed nothing stays quiet: same zero, opposite meaning.

## 0.1.11

A repair, and it is worth publishing on its own. Since 0.1.9, any `acc uninstall`
followed by `acc install` left the write guard switched off in Codex while every
indicator - `acc doctor`, `codex plugin list`, the client's own output - reported
health. Anyone who ran that pair is unprotected there until they upgrade.

| | |
|---|---|
| Built from | `bdd78a2` |
| Tarball | `agents-can-communicate-0.1.11.tgz`, 147 KB, 111 entries |
| sha256 | `0eec8874230233671aad83313b5f4030bc67a6b915ea0140d1e912ef4ac7d0ac` |
| Node | 24 (current production LTS) |
| Verified on | macOS 15 (darwin 25.5.0, arm64) and Linux in CI |
| Not supported | Windows — untested rather than known-broken |

**0.1.9 silently switched off the write guard in Codex, and 0.1.9's own release
notes state the opposite.** They say: *"Checked before touching them: a hook
whose recorded hash no longer matches still runs, so this is tidiness rather than
repair."* The check was real and the conclusion was wrong, because it perturbed
the record instead of removing it. Absence was never tested, and absence is the
whole mechanism.

Codex keeps one `[hooks.state."<plugin>:…"]` table per hook, holding a hash it
has trusted. With no table it runs no hook at all - and says nothing about it. It
prints `hook: SessionStart Completed` and executes nothing. Proven by replacing
ACC's hook with a two-line script that only appends its stdin to a file: an empty
file, beside a `Completed` line.

So after any `acc uninstall` followed by `acc install`, this was the state:

```
acc doctor         → 4 of 4 adapter(s) installed
codex plugin list  → installed, enabled, 0.1.10
the write guard    → off
```

A shell write walked straight through a `guarded` claim. Silently losing the
write guard is the worst failure this tool has.

Writing the same hashes back - captured before the deletion, from an ACC three
releases older - revived the guard immediately. That is also how we know the
record survives ACC upgrades and is granted once, by a person, for good. Nothing
ACC writes can put it back, so it is never ACC's to remove. Uninstall leaves it
alone now.

`acc doctor` says when a client's hooks are not trusted, because every other
indicator reads healthy while nothing runs:

```
store healthy; 0 live; protection none; 3 of 4 adapter(s) installed
  start codex once and accept the hook trust prompt  # its hooks run nothing until then
```

That line is an *action*, not a diagnostic. The first version of this fix put it
in `diagnostics`, which `acc doctor` renders only under `--json` - so on the very
machine it was written for, the text output stayed silent and the guard stayed
off. Adapters can now name something only a person can do, and it prints where a
person reads.

The reversal is recorded in [DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md) with
what it cost, along with the generalisation: to learn whether state is
load-bearing, take it away - changing it tests something else.

## 0.1.10

Two fixes about the same thing seen twice: the version a client caches ACC's
plugin under. It had been frozen at `0.1.6` for three releases, and unfreezing it
turned out to leave a copy behind on every upgrade. The second fix was found by
the first one's acceptance run.

This is also the first two-digit patch, which is the comparison the version guard
added in 0.1.9 was written for - `0.1.10` sorts before `0.1.9` as a string, and
did not here.

| | |
|---|---|
| Built from | `1c994f7` |
| Tarball | `agents-can-communicate-0.1.10.tgz`, 146 KB, 111 entries |
| sha256 | `cbf695c209f9eaa109a1254e09d0095c41a7c51641be2f2fc3dbf6fe94c96b89` |
| Node | 24 (current production LTS) |
| Verified on | macOS 15 (darwin 25.5.0, arm64) and Linux in CI |
| Not supported | Windows — untested rather than known-broken |

An upgrade leaves one copy of the plugin, not one per release. These clients
cache a plugin under its version, and until the previous release that version
never moved: every install landed in `0.1.6` and overwrote itself, so nothing
accumulated and nobody looked. Once the version started tracking the package,
the first upgrade left this behind:

```
~/.claude/plugins/cache/acc-local/agents-can-communicate/0.1.6
~/.claude/plugins/cache/acc-local/agents-can-communicate/0.1.9
~/.claude/plugins/cache/acc-local/agents-can-communicate/0.1.10
```

Three copies of ACC in a home that should hold one, and a fresh one every time
you upgrade. `acc uninstall` still cleared all of them, so this was litter rather
than breakage - but litter ACC put there and told nobody about, which is the
thing this tool promises not to do to other people's machines.

The tidy is scoped to the plugin's own directory. The marketplace cache root
above it holds every plugin installed from that marketplace, and removing that
root once took a plugin the user had installed themselves.

## Unreleased

| | |
|---|---|
| Built from | `3ace271` |
| Tarball | `agents-can-communicate-0.1.9.tgz`, 146 KB, 111 entries |
| sha256 | `49a0400e6c2db38b3e56ee6258f58a8b4dc9931be813bdb752e9e7b84d1aac57` |

Not published. A published record says what the registry serves and is not
rewritten, so shipped code that changes after a release is measured here instead.

The version a client caches ACC's plugin under is the version of the ACC that
installed it. It was a literal in each plugin manifest, updated by hand and by
nobody. Three releases after 0.1.6 the package was 0.1.9 while every client had
cached, listed and reported `0.1.6` - including `installed_plugins.json`, which
is where a person looks to answer "which ACC am I running".

Worse than cosmetic: the version string is how a client decides whether its
cached copy is still current. A bundle whose version never changes is a bundle a
client has no reason to replace, so an upgrade could leave the old plugin body in
place while the CLI moved on.

The fix is not "remember to bump three more files". The shipped manifests now
carry no version at all, and the install stamps the running one into the copy the
client reads. There is one version on the machine and nothing in the repository
that can fall out of step with it.

The tests that touched this were reading the version out of the same manifest, so
they followed the literal wherever it went and could never see it drift. They
read the package now.

## 0.1.9

Three fixes to installation, all found by breaking a real machine rather than by
reading the code. The one that matters: when a second ACC on the machine took
over every client's wiring, nothing said so - and the check built for exactly
that case had been disarmed by the same event.

| | |
|---|---|
| Built from | `4697a72` |
| Tarball | `agents-can-communicate-0.1.9.tgz`, 145 KB, 110 entries |
| sha256 | `f83415d679f300ac0d58c92b53a18a4739133c45846f0c386d7607f59fed40fc` |
| Node | 24 (current production LTS) |
| Verified on | macOS 15 (darwin 25.5.0, arm64) and Linux in CI |
| Not supported | Windows — untested rather than known-broken |

`acc doctor` names the ACC each client will actually run. Found by breaking a
machine: extending PATH to expose one client resolved `acc` to an 0.1.1 sitting
under a different Node version. That install rewired all four clients to itself,
and the only symptom was a guard behaving like the version it came from - a shell
write walked through a claim that 0.1.7 had learned to stop.

Nothing reported it. `staleInstall` compares the version recorded at install
against the one running now, and the 0.1.1 had rewritten that record with
`accVersion: null` - it predates the field. So the old ACC did not only replace
the wiring, it erased the evidence, and the check that existed for exactly this
went quiet at exactly the wrong moment.

The record is written by whoever writes last. The shim is not: it carries the
absolute path of the runner the client executes, and an old ACC writes it
honestly, pointing at itself. `acc doctor` now reads that path, resolves its
manifest, and says what it found:

```
acc install --adapter kimi  # wired to acc 0.1.1, this is 0.1.8
```

`acc install` refuses to wire an older ACC over a newer one, and `--downgrade`
asks for it deliberately. This is the weaker half and worth saying plainly: an
older release cannot enforce a check it does not contain, so it will not stop the
0.1.1 case that prompted this. It stops the same mistake between this release and
every one after it. The diagnosis above is what covers the rest.

Versions are compared per segment as numbers. A string comparison puts 0.1.10
before 0.1.9, which is the release where this would start refusing every
legitimate install.

`acc install --adapter <client>` installs that client even when the version probe
cannot find it. Presence was decided by running the client's `--version`, which
answers "can ACC run this client" - not the question that matters, since ACC
never runs it: the client runs ACC's hook. A CLI installed under a different Node
version sat there with its own configuration directory while every install said
"not installed on this machine". Naming the client is an answer to what the probe
was guessing at, and the skip now names that way past itself.

Presence is not inferred from the configuration directory existing. That was
tried first and is unsound: ACC creates those directories itself, and the attempt
read a client's own test fixture as proof the client was there.

## 0.1.8

Two fixes to what an agent reads and what it can answer with. Both came out of
a full end-to-end run of the published 0.1.7, and the first was found by a live
session rather than by its author.

| | |
|---|---|
| Built from | `9364e42` |
| Tarball | `agents-can-communicate-0.1.8.tgz`, 142 KB, 110 entries |
| sha256 | `13da399ce7d27dd650831458c708bee1e68dbaffba7294449cc92906f7617d1d` |
| Node | 24 (current production LTS) |
| Verified on | macOS 15 (darwin 25.5.0, arm64) and Linux in CI |
| Not supported | Windows — untested rather than known-broken |

A peer message says which part is which. The block carried the subject and the
body as two bare adjacent lines under a header that labels `id`, `from` and
`type` and nothing else:

```acc-peer-message
id message_… | from session_… | type note | untrusted peer message
SUBJECT-MARKER
BODY-MARKER: this is the body, not the subject
```

A reader could not tell them apart, and a two-line body made its first line read
as the subject. Found by a live session during an end-to-end run of 0.1.7: it
compared the injected text against `acc sync --json` and reported that reading
the injection alone would have made it repeat the subject as the body.

Both are labelled now. The subject is folded onto its label's line, because a
newline inside it would otherwise land peer text at column 0 - the one place a
reader takes as ACC's own words. A peer writing `subject:` or `body:` at the
start of a line gets the same treatment a forged fence already got: a `'` in
front of it, so it cannot produce a second line that reads as ACC framing a
different message.

The body is not reflowed. Indenting it was tried first and broke the rendering
of handoffs, whose bodies are structured text - which is the argument against
touching peer content at all when neutralising a marker will do.

A claim names its owner as a participant, not only as a session. `acc status
--json` gave `ownerSessionId`, and every command that reaches a peer - `acc
message --to`, `acc request --to` - takes a participant id, so "who holds this
file and how do I ask them for it" needed a join through the roster that every
caller wrote for itself. Observed costing a live agent that step. `ownerSessionId`
stays: it is what `acc release --authority` acts on, and two sessions of one
participant are still two holders. The lookup reads every session on record
rather than only the live ones, because a claim outliving its session is exactly
when the question gets asked.

## 0.1.7

One fix that matters and two that tidy after it. The one that matters: until
now a `guarded` claim stopped a file edit and nothing else, so the shell - the
way agents in these harnesses are told to change files - walked straight
through it.

| | |
|---|---|
| Built from | `22ee9c9` |
| Tarball | `agents-can-communicate-0.1.7.tgz`, 142 KB, 110 entries |
| sha256 | `16bbddfe242df6da5bf48aeec30a6f0c70cd7491cfbb71320fa4d60ef408c642` |
| Node | 24 (current production LTS) |
| Verified on | macOS 15 (darwin 25.5.0, arm64) and Linux in CI |
| Not supported | Windows — untested rather than known-broken |

A claim now holds against the shell. Found by asking a live Codex session to
append a line to a file another agent held guarded, and watching it succeed.

`printf '%s\n' '// via shell' >> src/parser.mjs` went through untouched, on a
`guarded` claim, in a workspace ACC reported as protected. So did `sed -i`, `mv`,
`rm` and every other shell write - on all four clients. The guard only ever read
the path out of an editing tool's arguments, and a shell call declares no path.

That was a deliberate decision, and its reasoning was sound: a command can write
anywhere, and a path *guessed* out of one blocks work at random while still
missing real writes. What it did not account for is that agents in these harness
are told to prefer the shell for file edits - this session's own instructions say
exactly that - so the uncovered path is not the exotic one. It is the default
one.

The answer is not to guess. The command is read for the positions where a write
is unambiguous, and for nothing else:

- a redirection - `> file`, `>> file`, `2> file` - but never `< file`, and never
  `/dev/null`
- the operands of commands whose whole job is to put bytes somewhere: `tee`,
  `touch`, `truncate`, `dd of=`, `rm`, `mv`, `cp`, `ln`, `install`
- in-place editors, only when the in-place flag is present: `sed -i`, `perl -i`
- `git restore` and `git checkout --`, which overwrite whatever a peer was
  holding

A read is never reported. `cat file`, `grep file`, `sed` without `-i` and
`git diff file` all name a path and write nothing, and blocking a session for
looking would be a worse failure than the one being fixed. Quoted text is text,
a heredoc body is content, and every command in a `&&` chain or a pipeline is
read rather than only the first.

Coverage is partial on purpose and the injected context now says so, where an
agent reads it: `file edits and recognised shell writes are blocked; a runtime
can still get past`. It used to promise the opposite - `edits made through a
shell are not` - which was honest about the gap and, read by an agent under
instructions to use the shell, amounted to directions around the guard. A
language runtime opening the file itself is still unseen. An agent that knows
where a guard ends behaves better than one that believes it absolute.

A claim is given back the way it was taken. `acc claim` takes `--resource` and
`acc release` took `--claim`, so handing one back meant a round trip through
`acc status --json` to find an id the caller never chose. Watched costing a live
agent a step mid-task. `--resource` now works on `release`; the id still works,
and stays the precise answer when an authority releases someone else's claim.

`acc uninstall` clears the trust record Codex keeps about ACC's hooks. That
client writes one table per hook, keyed by the plugin that declared them; ACC
writes none of them, so five were left behind naming a plugin that no longer
existed, and five more arrived on the next install. Checked before touching
them: a hook whose recorded hash no longer matches still runs, so this is
tidiness rather than repair. Only keys carrying ACC's own
`plugin@marketplace` prefix are removed.

## 0.1.6

Five fixes, and the one that matters most is that an agent in Codex can act at
all. Everything here came out of driving the real clients with live models
rather than with hand-written payloads.

| | |
|---|---|
| Built from | `b047ec5` |
| Tarball | `agents-can-communicate-0.1.6.tgz`, 136 KB, 109 entries |
| sha256 | `66c50759dbfb5cec31f6fa128e454542eb4f89fdb5fcdcd2ca9c9421f14d04fa` |
| Node | 24 (current production LTS) |
| Verified on | macOS 15 (darwin 25.5.0, arm64) and Linux in CI |
| Not supported | Windows — untested rather than known-broken |

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

`docs/CLI.md` names the condition on the promise it makes. It said an agent can
close its terminal and the next session it opens is still told - true only when
that agent has a name of its own. Without one, each run is a new participant and
nothing addressed to the last one reaches it. `docs/PROTOCOL.md` had said so all
along; the document a reader acts from had not.

Seen while running two real clients against one workspace: consecutive runs
appeared as `kimi-5P8POZ`, then `kimi-qUW4ei`.

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
