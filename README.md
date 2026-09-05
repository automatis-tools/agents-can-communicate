# agents-can-communicate

**Open your agents. Let them coordinate.**

Give Codex the backend. Ask Claude Code to build the interface. Keep working as usual.

ACC makes supported sessions in the same project aware of each other and gives them
instructions for coordinating. Agents discover their peers, share what they're working
on, and decide when to ask questions, agree on changes, or avoid overlapping edits.

Think of the coordination you expect from subagents, extended across the independent
sessions you open yourself — with different clients and models. You keep giving them
ordinary tasks; they handle the conversations around their work.

[Try it](#try-it) · [Supported clients](#when-messages-arrive) · [Documentation](docs/index.md)

[![CI](https://github.com/automatis-tools/agents-can-communicate/actions/workflows/ci.yml/badge.svg)](https://github.com/automatis-tools/agents-can-communicate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](https://nodejs.org)

## You describe the work. They work out the details.

Open two sessions in your project and give each its task:

| Session | Your prompt |
|---|---|
| Codex | Build the backend for account registration. |
| Claude Code | Build the registration screen. |

ACC's integration tells the agents that peers are present and teaches them how to find
out what those peers are doing. As they work, they can notice the dependency and coordinate
on their own. An illustrative exchange:

```text
Claude → Codex   I'm building the registration screen. What will your endpoint accept?
Codex → Claude   Email and password. I'll return the new user and handle validation.
Claude → Codex   I'll use that shape and keep my changes in the UI files.
```

The agents identify who to talk to and what to agree on. Your prompts stay focused on
the feature you want to build.

Each session keeps its own conversation and instructions. Response timing depends on the
receiving client: see [when messages arrive](#when-messages-arrive).

## Try it

You'll need **macOS or Linux, Node.js 24 or newer**, and two AI sessions in the same
project. They can use different clients or the same one.

```bash
npm install -g agents-can-communicate
acc install
```

The installer connects the clients it finds. Open a new terminal and restart your AI
clients to load the integration. If you use Codex, accept its plugin trust prompt.

Open two sessions in your project and give them ordinary tasks, as in the example above.
On supported clients, ACC introduces peer awareness through the client's own integration;
its installed instructions guide the agents to coordinate when their work overlaps.

Look for coordination in the agents' own activity: discovering a peer, checking who is
changing a file, or asking about a shared dependency. Each agent decides what is relevant
to its task; the integration provides awareness, not a guarantee that a model will
coordinate on every task. [Client support](#when-messages-arrive) determines how
automatically peers and messages reach it.

If the other session doesn't appear, run `acc doctor` from your project directory.
[Get help with setup](docs/TROUBLESHOOTING.md).

## When messages arrive

ACC connects sessions **on the same machine** and saves messages locally, so a waiting
session can pick them up later. Delivery depends on the client:

| Client | How the agent receives a message |
|---|---|
| Codex CLI, Claude Code, Gemini CLI, Kimi Code | At the next normal turn on verified versions and platforms; otherwise by checking its ACC inbox. |
| Grok or another client connected through [MCP](docs/MCP.md) | By checking its ACC inbox. |

**Claude Code can also reply while idle.** This optional mode is experimental and off by
default. It supports Apple Silicon Macs with zsh and Claude Code 2.1.258 or newer, subject
to compatibility checks. It can spend model tokens and requires accepting Claude's
development-channel warning at startup. Messages arriving mid-turn wait for it to finish.

Each direction follows the receiving client's rules: Claude's reply won't start a new
Codex turn. Codex can pick it up on a supported next turn or by checking its inbox.

[Full compatibility details](docs/CAPABILITIES.md).

## Keep the workflow you like

- **Your usual tools.** Start clients with their normal commands. You choose each
  agent's task, model, and permissions.
- **Separate checkouts, one project.** Git worktrees share an ACC workspace.
  Plain project folders work too; Git is optional.
- **Agree before editing.** Agents can reserve files and identify overlapping work.
  Reservations are advisory unless the clients support enforcement.
  [How reservations work](docs/CONCEPTS.md#intent-is-awareness-a-claim-commits).
- **Local coordination.** Messages live in app data outside your project. ACC doesn't
  collect or share raw transcripts. Your clients use their usual model providers.

One npm package. No account or separate coordination service to set up.

To remove the integrations:

```bash
acc uninstall
```

ACC preserves configuration changes you've made since installation.

## Go further

[Getting started](docs/GETTING_STARTED.md) · [CLI reference](docs/CLI.md) ·
[Connect an MCP client](docs/MCP.md) · [How ACC works](docs/HOW_IT_WORKS.md) ·
[Security](docs/SECURITY_MODEL.md)

Want to contribute or add a client?
Start with [AGENTS.md](https://github.com/automatis-tools/agents-can-communicate/blob/main/AGENTS.md)
and the [adapter guide](docs/ADAPTER_AUTHORING.md).
