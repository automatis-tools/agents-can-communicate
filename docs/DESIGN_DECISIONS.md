# Design decisions

Why ACC is shaped the way it is, and what is deliberately still open.

## Settled

| Decision | Reason |
|---|---|
| Local-first, same machine | Coordination that needs a server is coordination nobody sets up. |
| Git optional | The problem is concurrent sessions, not version control. A plain directory works. |
| Attach everywhere, materialise lazily | Universal attachment is what makes it ambient; lazy state is what makes a lone session free. |
| No permanent orchestrator | A lead session is a single point of failure and a lie about who owns the work. |
| Coordinators are scoped and replaceable | A workstream can benefit from one. A workspace never needs one. |
| `Intent` first-class, `Task` optional | Most real work is not a ticket. Forcing one is why coordination tools go unused. |
| Claims are workspace-global | Independent workstreams still share a filesystem. |
| Runtime state outside the repository | A checkout can be deleted, cloned, or synced; presence and locks must not travel with it. |
| Project config optional and runtime-free | A committed file is editable by anyone with a PR, so it may carry policy — never sessions or tokens. |
| Durable state is authoritative | Realtime delivery, if it ever exists, accelerates; it never becomes the source of truth. |
| No heartbeat helper in v1 | An idle session is honestly reported `stale`. A sidecar process to fake liveness is worse than the truth. |
| No process launching | ACC attaches to sessions you already own. Owning them is a different product. |
| One publishable package | One version and one release rather than twelve coordinated ones. |
| MIT | Widest reuse, least friction. |
| Node 24 (current production LTS) | Uses `node:test`, modern `fs` promises, and no transpiler. |
| MCP session from launch config | Never from `initialize` or `clientInfo` — those are attacker-controllable. See [THREAT_MODEL.md](THREAT_MODEL.md) scenario 8. |

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

## Still open

1. **Storage backend.** The hardened filesystem store ships first. A transactional backend
   can go behind the same interface later — but not merely to avoid a dependency.
2. **Remote coordination.** v2, or a separate product.
3. **Process launching.** Possibly never; possibly an external integration.
4. **Multi-root discovery rules** beyond the current `roots` list.
5. **Default claim lease length** for hook-only adapters. A hook-only session cannot sustain
   a short renewal cadence, so lease policy must not assume one.
6. **Windows.** Measured as not working, not merely untested — see [CHANGELOG.md](../CHANGELOG.md).
