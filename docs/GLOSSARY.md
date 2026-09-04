# Glossary

- **Workspace** — one local coordination room; all worktrees of a Git repository share it.
- **Participant** — the stable address that sends and receives messages.
- **Session** — one independently opened client conversation participating in a workspace.
- **Generation** — the token proving a mutation belongs to the current opening of a session.
- **Presence** — `online`, `stale`, or `offline`, based only on observed heartbeat and pid facts.
- **Intent** — a session's current summary and resource hints; awareness, not permission.
- **Claim** — a leased reservation for a canonical resource such as `file:src/**`.
- **Advisory / guarded** — a claim peers must respect versus one ACC can stop on measured client write paths; neither stops unrelated local processes.
- **Message** — an attributed untrusted `note`, `question`, `request`, `answer`, `decision`, or `handoff`.
- **Thread** — a root message plus linked answers sharing one immutable `threadId`.
- **Obligation** — `none`, `reply`, or `acknowledge`; what communication the recipient owes.
- **Receipt** — one recipient's monotonic `queued`, `offered`, `retrieved`, or `acknowledged` evidence.
- **Offered** — bytes crossed ACC's transport boundary; not proof the recipient read them.
- **Retrieved** — the participant received the body; not proof of model attention.
- **Acknowledged** — that participant explicitly acknowledged or replied; a reply is not proof requested work finished.
- **Next-turn delivery** — certified projection at the client's next normal turn; it never interrupts an active turn.
- **Live push** — optional delivery to an already-running session through an official certified client API. Claude Code 2.1.258+ on macOS arm64 qualifies, behind an opt-in; it waits for a turn in progress rather than interrupting it.
- **Recipient policy** — `off`, `actionable`, or `all`; opt-in permission to spend a turn, not a capability.
- **Delivery binding** — ephemeral, generation-bound reachability data owned by an adapter.
- **Fallback** — durable inbox or exact-certified next-turn recovery when live delivery is unavailable.
- **Managed / manual lifecycle** — whether hooks report ACC presence automatically; never ownership of the external client process.
- **MCP participation** — polling access to durable communication without native lifecycle, context, guards, or push.

See [Concepts](CONCEPTS.md) for relationships and [Protocol](PROTOCOL.md) for exact rules.
