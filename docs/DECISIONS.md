# Decisions

This file separates explicit user decisions from proposals. A new session must preserve that distinction.

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

## Strong direction inferred from the latest discussion

These are central design recommendations but still need one explicit user confirmation before implementation treats them as locked.

| Proposal | Rationale |
|---|---|
| Gemini CLI becomes a first-class native adapter in the first adapter wave | The product promise explicitly names Codex, Claude, and Gemini |
| Sessions automatically attach to workspace awareness | Removes repetitive user commands |
| No permanent project-wide orchestrator | Independent workstreams must not depend on whichever chat opened first |
| Optional coordinator per workstream | Preserves subagent-team ergonomics without central ownership |
| `Intent` is a first-class object | Agents need to expose informal exploration and review, not only formal tasks |
| Claims are workspace-global even when workstreams are independent | Prevents cross-team collisions |
| Runtime state lives outside the repository | Avoids dirty worktrees and makes the tool standalone |
| Project config is optional and committed only when the team wants shared policies | Zero-config by default, reproducible customization when needed |
| ACC does not launch or own agent processes in the first release | The core use case is attaching already-open human-driven sessions |
| Durable state is authoritative; realtime delivery is an optional acceleration | Closed or dormant models cannot be universally awakened |

## Open technical decisions

1. Storage after extraction: keep the hardened filesystem backend for the first standalone release, or add a transactional SQLite backend behind the same interface. `node:sqlite` is still release-candidate quality in the current Node LTS line, so this must not be selected merely to avoid an external dependency.
2. Exact npm package names and binary name. `acc` is preferred as the human command but availability must be checked before publication.
3. Public license.
4. Minimum Node.js version. Node 24 is the current LTS at the time of this handoff; pin only when packaging begins.
5. Whether remote/cloud coordination belongs in v2 or a separate product.
6. Whether an optional process-launching runner is ever part of ACC or remains an external integration.
7. Multi-root workspace configuration and discovery rules.

## Rejected directions

- A single file in each project that agents manually poll.
- A permanent global “Mayor” or lead session.
- Treating MCP as a guarantee of lifecycle, push delivery, or wake-on-message.
- Requiring Git, Git worktrees, tmux, PostgreSQL, or a hosted service for core local collaboration.
- Scraping and sharing complete model transcripts by default.
- Hiding capability degradation or reporting queued messages as delivered.
- Copying the Papercut-specific CLI and environment variables as the public API.
