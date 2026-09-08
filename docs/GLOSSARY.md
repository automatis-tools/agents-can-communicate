# Glossary

- **Workspace** — one same-machine, same-OS-user coordination room; all worktrees of a Git repository share it.
- **Participant** — the address that sends and receives messages; it survives unrelated conversations only when explicitly configured.
- **Session** — one independently opened client conversation participating in a workspace; its id supplies the default participant address.
- **Generation** — the token proving a mutation belongs to the current opening of a session.
- **Presence** — `online`, `stale`, or `offline`, based only on observed heartbeat and pid facts.
- **Intent** — a session's current summary and resource hints; awareness, not permission.
- **Claim** — a leased reservation for a canonical resource such as `file:src/**`.
- **Advisory / guarded** — CLI claims default to advisory. Explicit guarded enforcement also requires certified guards from every live participant; neither mode stops unrelated local processes.
- **Message** — an attributed untrusted `note`, `question`, `request`, `answer`, `decision`, or `handoff`.
- **Thread** — a root message plus linked answers sharing one immutable `threadId`.
- **Obligation** — `none`, `reply`, or `acknowledge`; what communication the recipient owes.
- **Receipt** — one recipient's monotonic `queued`, `offered`, `retrieved`, or `acknowledged` evidence.
- **Offered** — bytes crossed ACC's transport boundary; not proof the recipient read them.
- **Retrieved** — the participant received the body; not proof of model attention.
- **Acknowledged** — that participant explicitly acknowledged or replied; a reply is not proof requested work finished.
- **Next-turn delivery** — certified projection at the client's next normal turn; it never interrupts an active turn.
- **Live push** — optional delivery through Claude Code Channel or Codex LocalDaemon to an already-running session, behind recipient opt-in. Both wait for an active turn to finish; [Capabilities](CAPABILITIES.md) gives the measured eligibility and limits.
- **Recipient policy** — `off`, `actionable`, or `all`; opt-in permission to spend a turn, not a capability.
- **Delivery binding** — ephemeral, generation-bound reachability data owned by an adapter.
- **Fallback** — durable inbox or exact-certified next-turn recovery when live delivery is unavailable.
- **Managed / manual lifecycle** — whether hooks report ACC presence automatically; never ownership of the external client process.
- **MCP participation** — manual incoming polling without native lifecycle, context, guards, or receive wake; outgoing messages can use an eligible recipient's opted-in native route.
- **Bounded discovery** — inbox/history summary pages with limits and cursors; bodies require selection.
- **Exact recovery** — read one addressed inbox body, or one history record; history reads do not advance receipts.
- **Decision change** — an immutable decision explicitly supersedes or withdraws prior decisions; old records remain.
- **Current decision** — a terminal recorded position or withdrawal, not proven truth; competing branches stay visible.
- **Managed runtime** — ACC's staged installation generations and automatic-update controls, distinct from managed/manual session presence.
- **Activation hold** — an ACC process lease or native binding that postpones runtime refresh; observed lifecycle cleanup can release a native hold without stopping a vendor daemon.

See [Concepts](CONCEPTS.md) for relationships and [Protocol](PROTOCOL.md) for exact rules.
