# Design decisions

Why ACC is shaped the way it is, and what is deliberately still open.

## Settled

| Decision | Reason |
|---|---|
| Local-first, same machine | Coordination that needs a server is coordination nobody sets up. |
| Git optional | The problem is concurrent sessions, not version control; a plain directory works. |
| Attach everywhere, materialise lazily | Universal attachment is what makes it ambient; lazy state is what makes a lone session free. |
| No permanent orchestrator | A lead session is a single point of failure and a lie about who owns the work. |
| Coordinators are scoped and replaceable | A workstream can benefit from one. A workspace never needs one. |
| `Intent` first-class, `Task` optional | Most real work is not a ticket. Forcing one is why coordination tools go unused. |
| Claims are workspace-global | Independent workstreams still share a filesystem. |
| Runtime state outside the repository | A checkout can be deleted, cloned, or synced; presence and locks must not travel with it. |
| Project config optional and runtime-free | A committed file is editable by anyone with a PR, so it may carry policy — never sessions or tokens. |
| Durable state is authoritative | Realtime delivery, if it ever exists, accelerates; it never becomes the source of truth. |
| No heartbeat helper in v1 | An idle session is honestly reported `stale`. A sidecar process to fake liveness is worse than the truth. |
| Presence reads the process, never writes the record | A pid answers "gone" at once; an age floor covers what a pid cannot, including its own reuse. Nothing is written back — no session has authority to edit another's record. This checks a process already there, not one beating on a session's behalf like the heartbeat helper above. |
| No process launching | ACC attaches to sessions you already own. Owning them is a different product. |
| One publishable package | One version and one release rather than twelve coordinated ones. |
| MIT | Widest reuse, least friction. |
| Node 24 (current production LTS) | Uses `node:test`, modern `fs` promises, and no transpiler. |
| MCP session from launch config | Never from `initialize` or `clientInfo` — those are attacker-controllable. See the threat scenarios in [SECURITY_MODEL.md](SECURITY_MODEL.md) (scenario 8). |

## Rejected, and why

| Rejected | Why |
|---|---|
| A file in each repo that agents poll | No guard, no identity, no atomicity — and it ends up committed. |
| A permanent global lead session | Turns peers into workers and makes one crash fatal. |
| Treating MCP as a lifecycle guarantee | MCP is a tool surface. It cannot attach, guard, or wake anything. |
| Requiring Git, tmux, PostgreSQL, or a service | Every requirement is a reason the tool is not installed. |
| Sharing full transcripts by default | Coordination needs intent and claims, not conversations. |
| Reporting queued messages as delivered | A delivery state that overstates itself is worse than no state. |
| Guessing file paths out of shell commands | It would block work at random and still miss real writes. See [CAPABILITIES.md](CAPABILITIES.md). |

**Reversed in 0.1.11: removing the client's hook-trust record on uninstall.**
0.1.9 took Codex's `[hooks.state."<plugin>:…"]` tables out on uninstall,
reasoning they named a plugin that was gone. The check behind that reasoning
perturbed the record instead of removing it — a hook whose recorded hash no
longer matched was still observed running, so absence was never actually
tested.

Absence is the whole mechanism. With no record, the client runs no hook at
all, prints `hook: SessionStart Completed` while executing nothing, and ACC's
write guard goes silently off — while `acc doctor` and `codex plugin list`
both report it enabled. On a real machine, a shell write walked through a
guarded claim; writing the exact same hashes back (captured before deletion,
from an ACC three releases older) revived the guard immediately.

That is why removal is never ACC's to do: the record is granted once by a
person, survives ACC upgrades, and nothing ACC writes can restore it.
Tidiness is not worth a permission only a human can re-grant.

**The generalisation, since this cost a release:** to learn whether state is
load-bearing, take it away. Changing it tests something else.

**Reversed in 0.1.7: reading write positions out of shell commands.** The
rejected row above still holds against *guessing* — it stays because its
reasoning shaped the replacement. What changed was the evidence: a live Codex
session asked to append to a file another agent held guarded went through
untouched via `printf ... >> file`. Agents here are told to prefer the shell
for edits, so this was the common path, not an edge case.

The fix is to read, not guess: only a redirection, or the operand of a
command whose job is to put bytes somewhere, counts as a write position. A
read is never reported, so the failure the rejected row feared — blocking
work at random — cannot occur; only paths a command would actually write get
declared. Coverage is deliberately partial, and
[CAPABILITIES.md](CAPABILITIES.md) says where it ends: an agent that knows
where a guard stops behaves better than one that believes it absolute.

## Still open

1. **Storage backend.** The hardened filesystem store ships first. A transactional backend
   can go behind the same interface later — but not merely to avoid a dependency.
2. **Remote coordination.** v2, or a separate product.
3. **Process launching.** Possibly never; possibly an external integration.
4. **Multi-root discovery rules** beyond the current `roots` list.
5. **Default claim lease length** for hook-only adapters. A hook-only session cannot sustain
   a short renewal cadence, so lease policy must not assume one.
6. **Windows.** Measured as not working, not merely untested — see the
   [repository changelog](https://github.com/automatis-tools/agents-can-communicate/blob/main/CHANGELOG.md).

---

See also: [README](index.md) for navigation and [Glossary](GLOSSARY.md) for terms.
