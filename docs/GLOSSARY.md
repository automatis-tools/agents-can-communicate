# Glossary

One definition per term. Where a term has a fuller treatment, the link points to its home.

- **Room** (workspace) — the shared coordination space for one project. Every worktree of a repo shares one room; a plain folder works the same. See [Concepts](CONCEPTS.md).
- **Participant** — a stable identity in a room (e.g. `claude_code`, `codex`, or a name you set with `ACC_PARTICIPANT`). Work addressed to a participant survives a restart. See [Protocol](PROTOCOL.md).
- **Session** — one live run of a client. A session dies with its process; it is identified by a session id plus a generation. Work addressed to a *session*, not a participant, dies with it.
- **Generation** — a counter that proves ownership of a session across resumes. It is never printed by `acc status` — it is proof, not public information.
- **Presence** — a session reads as **online**, **stale**, or **offline**, derived from the client's process and recent activity. See [Architecture](ARCHITECTURE.md).
- **Intent** — what a session says it is doing right now, published with `acc work`. Awareness, not a reservation.
- **Claim** — a reservation on a resource (a file or glob such as `file:src/**`), taken with `acc claim`. See guarded vs advisory below. See [Concepts](CONCEPTS.md).
- **Guarded vs advisory** — the room's protection level. Under **guarded**, a clashing write from another session is refused and the owner is named; under **advisory**, the claim only warns. One MCP participant in the room makes it advisory for everyone. See [MCP](MCP.md).
- **Message** — a typed note to other participants (`note`, `question`, `answer`, `decision_proposal`, `blocker`, `handoff`, and more), delivered on the recipient's next turn. A message is data the recipient weighs, never a command it obeys.
- **Note vs question** — a `note` is delivered once and leaves one recoverable breadcrumb; a `question` (or any `--requires-ack` message) keeps a standing reminder until it is acknowledged with `acc ack`.
- **Inbox** — a participant's targeted mail, read with `acc inbox`; replies go back with `acc reply`.
- **Handoff** — an end-of-turn record written with `acc finish`: what is done, what remains, what is blocked — and it releases the session's claims.
- **Attention** — the room's prioritized signals a session should act on (six kinds, e.g. `direct_request`, `claim_conflict`, `unread_note`). See [Architecture](ARCHITECTURE.md).
- **Managed vs manual** — whether ACC controls a client's session lifecycle. A native adapter is **managed** (ambient attach, guarded writes, injected context); an MCP client is **manual** — the participation tier, advisory only. See [MCP](MCP.md) and [Capabilities](CAPABILITIES.md).
