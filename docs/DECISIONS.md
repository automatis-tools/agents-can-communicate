# Decisions

This file separates explicit user decisions from open technical decisions. As of 2026-08-15 no design proposals remain unapproved; a new session must not silently resolve an open technical item.

## Approved by the user

| Decision | Status |
|---|---|
| Standalone repository at `automatis-tools/agents-can-communicate` | Approved |
| Canonical remote `git@github.com:automatis-tools/agents-can-communicate.git` | Approved |
| Distribution starts as npm/npx CLI | Approved |
| Product shape is CLI plus adapters | Approved |
| Local-only, same-machine collaboration first | Approved |
| Git is optional rather than required | Approved |
| Native Codex and Claude Code support | Approved |
| Generic MCP integration exists as a fallback | Approved |
| Setup should feel automatic, using hooks and skills where clients support them | Approved |
| Product must be model-agnostic and allow agents from different companies to collaborate | Approved |
| Every supported session silently attaches to workspace awareness | Approved 2026-08-15 |
| No session becomes a permanent project-wide orchestrator | Approved 2026-08-15 |
| Workstream coordinators are optional, scoped, and replaceable | Approved 2026-08-15 |
| `Intent` is first-class; formal Tasks remain optional | Approved 2026-08-15 |
| The first release does not launch or own agent processes | Approved 2026-08-15 |
| Attach policy: attach everywhere with lazy durable materialization — durable state appears on the second live session or the first claim/message/other durable object; until then presence and Intent are ephemeral | Approved 2026-08-15 |
| Idle presence: v1 ships no detached heartbeat helper; idle sessions are truthfully reported `stale` | Approved 2026-08-15 |
| Gemini CLI is a first-class native adapter in the first adapter wave | Approved 2026-08-15 |
| Claims are workspace-global even when workstreams are independent | Approved 2026-08-15 |
| Runtime state lives outside the repository | Approved 2026-08-15 |
| Project config is optional and committed only when the team wants shared policies | Approved 2026-08-15 |
| Durable state is authoritative; realtime delivery is an optional acceleration | Approved 2026-08-15 |
| Peer equality: any top-level session can represent the whole Workspace — it answers whole-system questions from shared state (including other participants' subagents) and relays human requests to any participant; authority differences apply to mutation only, never to knowledge | Approved 2026-08-15 |
| Solo zero-overhead: a lone session pays nothing visible — no injected coordination context, no required protocol actions, guards short-circuit against the empty roster; coordination kicks in at the first safe point after a second session attaches or a durable object exists | Approved 2026-08-15 |
| MCP session model: the ACC session is derived from the MCP server's own launch configuration (participant name and workspace), never from `initialize`, connection identity, or `clientInfo`; presence refreshes per tool call and a restarted process resolves to the same session | Approved 2026-08-16 |
| Public license is MIT | Approved 2026-08-16 |
| Publication model: one publishable package, `agents-can-communicate`, carrying the workspaces inside it — one version and one release rather than eight coordinated ones. Verified available on npm the same day, as was the `@agents-can-communicate` scope; the npm package `acc` exists but declares no binary, so the `acc` command collides with nothing published | Approved 2026-08-16 |
| Minimum Node.js is the current production LTS, 24 (`v24.19.0` Krypton, released 2026-08-03) | Approved 2026-08-16 |

## Open technical decisions

1. Storage after extraction: keep the hardened filesystem backend for the first standalone release, or add a transactional SQLite backend behind the same interface. `node:sqlite` is still release-candidate quality in the current Node LTS line, so this must not be selected merely to avoid an external dependency.
2. Whether remote/cloud coordination belongs in v2 or a separate product.
3. Whether an optional process-launching runner is ever part of ACC or remains an external integration.
4. Multi-root workspace configuration and discovery rules.
5. Default claim lease length and renewal cadence for hook-only adapters. The prototype pairs 1800-second leases with a 15-second watcher heartbeat; a hook-only session cannot sustain that cadence, so lease policy must not assume it.

## Rejected directions

- A single file in each project that agents manually poll.
- A permanent global “Mayor” or lead session.
- Treating MCP as a guarantee of lifecycle, push delivery, or wake-on-message.
- Requiring Git, Git worktrees, tmux, PostgreSQL, or a hosted service for core local collaboration.
- Scraping and sharing complete model transcripts by default.
- Hiding capability degradation or reporting queued messages as delivered.
- Copying the Papercut-specific CLI and environment variables as the public API.
