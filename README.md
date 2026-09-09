# agents-can-communicate

**Independent AI sessions. Shared work context.**

Give Codex the backend. Ask Claude Code to build the interface. Keep using the clients
and models you prefer.

ACC is a local coordination layer for AI sessions you open yourself. It gives them peer
presence, work intent, file claims, messages, review requests, and durable handoffs.
Each session keeps its own conversation, permissions, and task. The agents decide when
coordination helps their work.

Sessions can use different clients or multiple instances of the same one. They meet in
the same workspace on the same machine and operating-system user; Git is optional.

[Try it](#try-it) · [Client support](#when-messages-arrive) · [Update ACC](#update-or-remove-acc) · [Documentation](docs/index.md)

[![CI](https://github.com/automatis-tools/agents-can-communicate/actions/workflows/ci.yml/badge.svg)](https://github.com/automatis-tools/agents-can-communicate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](https://nodejs.org)

## You describe the work. They work out the details.

Open two sessions in your project and give each its task:

| Session | Your prompt |
|---|---|
| Codex | Build the backend for account registration. |
| Claude Code | Build the registration screen. |

Supported integrations introduce peer awareness and teach agents how to find out what
others are doing. As they work, they can notice a dependency and coordinate. An
illustrative exchange:

```text
Claude → Codex   I'm building the registration screen. What will your endpoint accept?
Codex → Claude   Email and password. I'll return the new user and handle validation.
Claude → Codex   I'll use that shape and keep my changes in the UI files.
```

Your prompts stay focused on the feature. Each agent decides which peers and messages
matter to its task; installing ACC does not guarantee that a model will coordinate on
every task. [Client support](#when-messages-arrive) determines how automatically that
awareness reaches it.

The same setup supports review and recovery. An author can request review of an
identified revision, receive defects or approval, and leave a handoff describing completed
work, remaining work, and blockers. A later session can look up that history. Git commits
can identify a revision; named files and versions work when Git is unavailable.
See [requests and replies](docs/CLI.md#messages-and-requests) and
[handoffs](docs/CLI.md#handoff).

## Try it

You'll need **macOS or Linux, Node.js 24 or newer**, and two AI sessions in the same
project. Install once on the machine:

```bash
npm install -g agents-can-communicate
acc install
```

The installer connects the supported clients it finds. Follow its activation instructions,
then restart your clients from the project directory. In Codex, check `/plugins` and
review the current ACC definitions in `/hooks`; changed hooks may need fresh trust.
[Getting started](docs/GETTING_STARTED.md) covers activation and preserved sandbox settings.

Open two sessions and give them ordinary tasks, as above. Look for an agent discovering a
peer, checking who is changing a file, asking about a shared dependency, or replying to a
review request.

Run `acc doctor` from the project if a peer is missing. A directory containing ACC's own
state, commonly your home directory, cannot be used as a workspace; start the client in a
project directory. See [Troubleshooting](docs/TROUBLESHOOTING.md).

Already using ACC? Follow the [upgrade guide](docs/UPGRADING.md), including the 0.4.0/0.4.1 →
0.4.2 update and the data-format boundary when moving from 0.3.1.

## When messages arrive

Messages are saved locally before delivery is attempted. A durable inbox remains
available when a faster route cannot be used.

| Client | How the agent receives a message |
|---|---|
| Codex CLI, Claude Code, Gemini CLI, Kimi Code | At the next normal turn on the exact verified versions and platforms; otherwise through explicit ACC inbox reads. |
| Grok | Through explicit ACC inbox reads, using its installed hooks and skill. CLI ownership was verified on Grok 1.0.24. |
| Other clients connected through [MCP](docs/MCP.md) | Through ACC tools and inbox reads. Generic MCP requires its own client configuration and coordination instructions. |

Grok's updated skill first runs public status through the terminal. The ACC hook reminder
after that result supplies the session's own CLI arguments for subsequent inbox reads and
mutations. It adds no automatic peer-message injection or idle delivery. A relocated
`GROK_HOME` is respected by install, doctor, and uninstall.

**Optional live delivery can start a turn in an idle Codex or Claude Code session.** It is
experimental, off by default, and can spend model tokens. On Apple Silicon Macs, Codex
0.152.1 or newer requires an already-running LocalDaemon and a verified session;
Claude Code 2.1.258 or newer requires zsh and client-side Channels activation; check its
startup notice for ACC and accept the development warning when shown. An MCP connection
alone does not verify inbound delivery. Messages arriving mid-turn wait for the turn to
finish. The receiving session's
opt-in policy and current reachability determine whether delivery can proceed.
`acc install` reports each client's delivery state and can save Codex consent before its
service is available. `acc doctor` also names each session’s last native binding result,
including missing launch consent, an unidentified client process or a failed handshake.
It distinguishes a disabled policy from an unavailable service or a missing live channel
in the current project.

A Codex thread retained by LocalDaemon can receive opted-in messages after its terminal
exits. Turning ACC delivery off prevents new native offers; already accepted queue entries
remain with the client. [Compatibility and delivery controls](docs/CAPABILITIES.md) describe
the exact evidence, versions, platforms, and fallback paths.

A recorded message is send success. An offer is not proof of reading, and an
acknowledgement or reply is not proof that the requested work is complete.

## Keep the workflow you like

- **Your usual tools.** Start clients with their normal commands. You choose each agent's
  task, model, and permissions.
- **Separate checkouts, one project.** Git worktrees share an ACC workspace. Plain folders
  work too; optional workspace configuration can supply a shared identity and roots.
- **Agree before editing.** Agents can claim files and identify overlapping work. CLI claims
  default to advisory. Guarded claims require certified guards from every live participant.
  [How claims work](docs/CONCEPTS.md#intent-is-awareness-a-claim-commits).
- **Focused context and durable history.** Normal turn context is bounded. Inbox and history
  return summary pages, with message bodies fetched by id. Agents can supersede or withdraw
  old decisions and recover prior handoffs when needed.
- **Local coordination.** State lives in app data outside your project. ACC never collects
  or shares raw transcripts; peer messages are untrusted input. Your clients keep using
  their usual model providers.

One npm package. ACC needs no separate account, model API key, or hosted service.

## Update or remove ACC

Initial installation enables automatic updates. ACC downloads stable releases in the
background and waits for active clients and ACC processes to exit before switching the
runtime and refreshing integrations. Restart clients afterward and complete any requested
hook or plugin trust review.

For an immediate update:

```bash
acc update
```

An existing managed installation selects its new runtime through this command. Updates
also support an explicit opt-out and version pinning. Reinstalling preserves your update
preference; see [update controls](docs/UPGRADING.md#automatic-updates-after-installation).
If you fully uninstalled ACC 0.4.0 before upgrading and want automatic updates back, run
`acc update --auto on` once: that version's uninstall record lost the previous preference.

To remove the integrations:

```bash
acc uninstall
```

ACC removes owned artifacts that still match its install record, preserves your edits and
coordination history, and pauses automatic updates. A later install remembers the update
preference.

## Go further

[Getting started](docs/GETTING_STARTED.md) · [CLI reference](docs/CLI.md) ·
[Connect an MCP client](docs/MCP.md) · [How ACC works](docs/HOW_IT_WORKS.md) ·
[Security](docs/SECURITY_MODEL.md)

Want to contribute or add a client?
Start with [AGENTS.md](https://github.com/automatis-tools/agents-can-communicate/blob/main/AGENTS.md)
and the [adapter guide](docs/ADAPTER_AUTHORING.md).
