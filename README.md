# Agents Can Communicate (ACC)

[![Mentioned in Awesome Claude Code](https://awesome.re/mentioned-badge.svg)](https://github.com/hesreallyhim/awesome-claude-code)

**The message your clients can’t send each other.**

Claude Code can message your other Claude Code sessions, and Codex can queue a message for
another Codex session. From Claude Code, OpenAI’s Codex plugin can ask Codex for a review,
hand it a task or move the conversation into Codex; it runs Codex under Claude Code, in that
direction only. Neither client offers a way to message a session you opened yourself in the
other one. ACC carries questions, reviews and handoffs between those sessions, in either
direction, on your machine.

You open each client normally and choose its work. Every session keeps its own model,
conversation, and permissions. Coordination runs locally, with no lead agent managing the
others. If all your sessions run in one of these two clients, try its own messaging first.

```mermaid
flowchart TB
    you["You choose the tools and work"]
    codex["Codex<br/>Feature A"]
    claude["Claude Code<br/>Feature B"]
    antigravity["Antigravity CLI<br/>Feature C"]
    acc["Communication via ACC"]

    you -.-> codex
    you -.-> claude
    you -.-> antigravity
    codex <--> acc
    claude <--> acc
    antigravity <--> acc

    subgraph handoff["When you switch clients"]
        direction LR
        current["Claude Code<br/>session"] --> saved["Handoff<br/>Done · Decisions<br/>Next steps"]
        saved --> next["Codex<br/>session"]
    end
    acc ~~~ handoff

    classDef human fill:#f1f5f9,stroke:#8593a3,color:#202a35
    classDef session fill:#fff,stroke:#ced4d9,color:#202a35
    classDef shared fill:#e8edff,stroke:#385cde,color:#202a35
    class you human
    class codex,claude,antigravity,current,next session
    class acc,saved shared
    style handoff fill:transparent,stroke:#ced4d9
    linkStyle 3,4,5,6,7 stroke:#385cde,stroke-width:2px
```

## When ACC helps

- **Run parallel work across clients.** Start each task in whichever client has limit left,
  and let the sessions see who is working on what, ask each other about a shared API, and
  agree who takes which issue before they build around different assumptions.
- **Get a second opinion from another vendor’s model, in either direction.** Ask a Codex
  session you already have open to review a change your Claude Code session just made, and
  send its findings back to the session that wrote the code; or let Codex ask Claude Code.
- **Switch clients mid-feature.** When a limit approaches or another model suits the work
  better, leave a handoff with decisions, unfinished work and what was verified, rather than a
  transcript, for a session in the client you open next.

## Try one feature across two clients

You’ll need **macOS, Linux or Windows 10/11, Node.js 24 or newer**, and supported coding
clients on the same machine and operating-system user. On Windows, ACC runs natively, with no
WSL, and live delivery reaches Claude Code, Codex and Antigravity CLI there too. See
[Windows](docs/GETTING_STARTED.md#windows).

```bash
npm install -g agents-can-communicate
acc install
```

The installer connects supported clients it finds. Follow its activation instructions, review
any required hook or plugin trust, then restart your clients from the project directory. The
[setup guide](docs/GETTING_STARTED.md) covers client-specific steps.

Open Claude Code and Codex in the same project and give each one its own part of one feature.
Ask Codex:

```text
Add an account-registration endpoint.
```

And ask Claude Code:

```text
Build the account-registration screen.
```

Those are the whole prompts. Each session sees that the other is present and what it is
working on. When the screen needs the endpoint’s request and response shape, the Claude Code
session can ask the Codex session and get the answer at its next turn, without you carrying
it across; the sender can check whether its question was delivered and answered. The agents
decide when to coordinate; ACC does not guarantee they will notice every dependency.

The same channel carries a review: ask the session that made a change to request a review
from the other session in ACC, naming the files, and ask the other to answer it. The
[setup guide](docs/GETTING_STARTED.md#2-open-two-sessions-and-give-them-ordinary-tasks)
walks through both.

## Client support

Integrations are available for **Antigravity CLI, Claude Code, Codex, Grok, and Kimi Code**.
Other clients can connect through [MCP](docs/MCP.md) with their own configuration and
coordination instructions.

Automatic delivery depends on the client version and platform. Verified integrations can
provide messages at the next normal turn; other sessions read their ACC inbox explicitly.

Experimental live delivery can wake eligible Claude Code, Codex and Antigravity CLI
sessions, conversations in the Antigravity desktop app, and local Code sessions in Claude.app.
It requires opt-in and an active verified connection, is off by default, and can spend model
tokens. Claude Code sessions wake through the inbox that Claude Code itself opens, so you start
Claude Code with your ordinary command. A busy Claude Code session gets the message between two
tool calls. A busy Codex session gets it when the current turn ends. Chats in the Codex app run
on the app’s own server and get messages at their next turn.

See [client capabilities](docs/CAPABILITIES.md) for exact support. Run `acc doctor` from your
project if a peer is missing or delivery differs from what you expect; see
[troubleshooting](docs/TROUBLESHOOTING.md). Agents decide when to coordinate; ACC does not
guarantee they will notice every dependency.

## Local and independent

Sessions share coordination within the same ACC workspace. Git is optional; worktrees of one
repository share that workspace while keeping separate files. Messages and handoffs are stored
in local app data outside your project. ACC never collects or shares raw session transcripts.

ACC needs no separate account, model API key, or hosted service. Your coding clients keep using
their existing provider access.

Automatic updates are enabled on first install. Use `acc update --auto off` to disable them,
`acc update` to update manually, and `acc uninstall` to remove integrations. See
[update controls](docs/UPGRADING.md) for details.

MIT-licensed and permanently noncommercial. Try it on one real task and
[open an issue](https://github.com/automatis-tools/agents-can-communicate/issues/new/choose)
with what happened: whether it worked, where it broke, or where you still had to carry
messages between sessions yourself. If it worked, watch the repository’s releases to hear
about the next one. Longer write-ups and setups are welcome in
[Discussions](https://github.com/automatis-tools/agents-can-communicate/discussions).

[Documentation](docs/index.md) ·
[Contributing](https://github.com/automatis-tools/agents-can-communicate/blob/main/AGENTS.md)
