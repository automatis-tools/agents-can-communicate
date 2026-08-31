# Presence and pid-reuse — archived design note

> Internal reference. The live [architecture doc](../ARCHITECTURE.md) carries a
> three-state summary; this is the full rationale it points to.

## Presence

Three observable states: online, stale, offline. Heartbeats arrive only where a harness
exposes them — hook safe points, or tool calls for MCP. An idle-but-open session degrades
to `stale`, and that is truthful reporting rather than an error. Only Kimi Code fires on a
timer; see [CAPABILITIES.md](CAPABILITIES.md).

A session reads `offline` when it is closed; when its recorded process is confirmed dead;
when it has no recorded process and has been silent past thirty minutes — the point past
which nobody can tell whether it is alive; or when it has been silent past twenty-four
hours regardless of its process, because a process number can be reissued to something
unrelated and a pid that still answers is not proof it is the same session. `online` and
`stale` are unaffected: they still come from the session's own declared heartbeat cadence.

A recorded process to confirm dead is not something every client gets, either - it comes
from matching the adapter's own binary name against the operating system's name for the
process, which fails for a client that is a script rather than an executable. Half of the
shipped adapters resolve one and half do not; see [CAPABILITIES.md](CAPABILITIES.md).

An open session's id is reused only once its recorded process is confirmed dead — a closed
one is already free, since closing is the session's own choice, not a presence judgment
made about it. Presence staleness alone never reuses an open session's id: an idle session
may resume at any moment, and a session with no recorded pid stays owner of its id however
long the silence, regardless of age. Only the operating system's word that the process is
gone is authority to hand it to someone else.

One gap in that rule is left open rather than fixed: a pid the OS has reissued to an
unrelated long-lived process answers alive forever, past even the twenty-four-hour floor
that retires everything else, because a pid that answers past that floor is either a live
idle session or a recycled number and there is no way to tell which. "Cannot tell" is never
authority for reusing a session's id, so this reads offline in presence but stays live for
replacement — a wrong answer no more frequent than pid recycling itself, and reachable only
through `acc attach --session <id>`, since the hook path always mints a fresh id rather than
naming an existing one.

A claim follows the same restraint for its own reason: presence never releases one, only
an expired lease or an explicit force release does — see
[PROTOCOL.md](PROTOCOL.md#claim-lifetime-and-stale-owners).

A workstream coordinator is one role presence staleness alone *does* replace: it is
contestable by any peer the moment its holder reads `offline`, silence-based cases
included, with no confirmed death and no human or policy authority required. That is
deliberate, not an oversight — a coordinator whose process was killed used to leave its
workstream stuck with an uncontestable coordinator forever, the same failure this branch
exists to fix. The role can afford it where a session id cannot: taking a coordinator
destroys nothing and the original holder can reacquire it the moment it is back, while
reusing a session id cannot be undone — the displaced session's own heartbeats fail with
CONFLICT from then on.

Task assignment is the other. `acc task --take` on a task already held by someone else's
session refuses outright while the holder reads `online`, and requires `--force` while it
reads `stale` — but once the holder reads `offline`, the task is simply taken, silence-based
cases included, with no force and no confirmation that the holder's process is actually
dead. A holder attached over MCP, which never records a pid, reads `offline` from silence
alone after thirty minutes with no tool call to heartbeat it. This is acceptable for the
same two reasons the coordinator case is: the participant guard still refuses a different
participant's session regardless of presence, so the blast radius is one participant taking
its own work back from itself, and a task taken back is reversible — nothing is destroyed,
and the original holder can pick it back up the moment it resumes.

