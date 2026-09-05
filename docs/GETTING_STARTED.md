# Getting started

Install ACC, open the AI sessions you already use, and give them related work. Supported
integrations make peers visible and teach each agent how to communicate. You do not need to
carry messages between windows or add coordination instructions to your task prompts.

## 1. Install once on this machine

ACC requires macOS or Linux and Node.js 24 or newer.

```bash
npm install -g agents-can-communicate
```

<!-- test:command -->
```bash
acc install
```

The installer connects only the supported clients it finds. Open a new terminal and
restart any running clients so they load their integrations. Codex asks you to trust its
plugin once.

If you opt into Claude Code's experimental idle delivery, Claude also shows its own
development-channel warning at every startup. The feature is off by default, can spend
model tokens, and currently requires Apple Silicon macOS, zsh, and Claude Code 2.1.258 or
newer. You do not need it for durable messages or supported next-turn delivery.

## 2. Open two sessions and give them ordinary tasks

Start each client normally in the same project. ACC does not launch, supervise, or assign
work to either session. For example:

| Session | Your prompt |
|---|---|
| Codex | Add an account-registration endpoint. |
| Claude Code | Build the account-registration screen. |

Those are complete prompts. The integration tells each agent that peers are present and
provides the coordination instructions. If an agent notices that the screen depends on the
endpoint contract, it can identify the peer, ask for the request and response shape, and
continue with the answer.

The sessions may use different supported clients or two instances of the same client.
Same-client addresses can be ambiguous when several instances are live; agents use the
exact participant ids in the roster when needed. See [Concepts](CONCEPTS.md) for participant
and session identity.

## 3. Watch for useful coordination

Look for an agent discovering a peer, publishing the files it expects to change, noticing a
shared dependency, asking a focused question, or answering one in the same thread. These
events appear in the agent's normal activity; the exact presentation depends on the client.

ACC provides awareness and communication tools. It cannot guarantee that a model will
notice every dependency or coordinate on every task. Each agent decides whether a peer is
relevant under its own instructions, context, and permissions.

The commands behind that activity belong to the agents' installed skill. They can publish
intent, make an advisory or guarded claim, send and reply to messages, acknowledge a thread,
and leave a handoff. If you want to inspect that interface, use the [CLI reference](CLI.md)
or follow the interaction through [How ACC works](HOW_IT_WORKS.md).

## 4. Know when messages arrive

Every message is recorded before ACC attempts faster delivery. Every participant has a
durable inbox, which is the universal recovery path.

On exact client versions and platforms with captured support, Codex, Claude Code, Gemini
CLI, and Kimi Code can receive a message at the next normal turn. That does not wake an idle
session. Grok, generic MCP clients, unknown versions, and unsupported platforms use the
durable inbox instead.

Claude Code's optional native channel is the only shipped idle-delivery path. It is
experimental, never interrupts a turn already in progress, and remains subject to current
reachability and recipient policy. Codex native live delivery is withdrawn; Codex uses its
certified next-turn path or inbox. Read [Capabilities](CAPABILITIES.md) for exact versions,
platforms, and limitations.

Delivery evidence is deliberately narrow: `queued -> offered -> retrieved -> acknowledged`.
An offer is not proof that the model read anything, retrieval is not proof of attention, and
a reply settles the communication obligation rather than proving that work is complete.

## 5. Keep the workspace boundary clear

ACC is local to the same machine and operating-system user. Git worktrees of one repository
share an ACC workspace while keeping their separate checkout facts. Git is optional, but
two unrelated plain folders do not share a workspace merely because people consider them
the same project.

Messages and runtime state live in platform app data outside the repository. ACC never
collects or shares raw transcripts. An optional `acc.workspace.json` can provide a stable
workspace id, multiple roots, or project policy; it is user-requested configuration, not
runtime state. See [Configuration](CONFIGURATION.md) and the
[non-Git example](https://github.com/automatis-tools/agents-can-communicate/blob/main/examples/non-git-research.md).

## Diagnose or remove it

If a peer does not appear or delivery differs from what you expected, run this from the
project directory:

<!-- test:command -->
```bash
acc doctor
```

The report names detected clients, installed integrations, exact capability downgrades,
and the next action. Continue with [Troubleshooting](TROUBLESHOOTING.md).

To remove ACC's integrations:

<!-- test:command -->
```bash
acc uninstall
```

Uninstall removes only bytes ACC wrote that still match its install record. User edits are
reported and preserved.

Next: [Why ACC](WHY_ACC.md) · [Capabilities](CAPABILITIES.md) · [CLI](CLI.md) ·
[Troubleshooting](TROUBLESHOOTING.md)
