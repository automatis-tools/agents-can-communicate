# Getting started

Install ACC, open the AI sessions you already use, and give them related work. Supported
integrations make peers visible and teach each agent how to communicate. You do not need to
carry messages between windows or add coordination instructions to your task prompts.

Active hooks can supply each agent's own CLI arguments; the installed skill tells the
agent how to use them. This path was observed in Claude Code 2.1.263, Codex 0.153.4, and
Grok 1.0.24. Grok receives its own header after a terminal result, so its skill runs public
status first; peer messages still require explicit inbox reads. Hooks must be enabled and
trusted by the client. Without that owner context, owned operations require an explicit
pair or session-bound ACC MCP tools. See [CLI ownership](CLI.md#coordinate-from-a-session).

## 1. Install once on this machine

ACC requires macOS or Linux and Node.js 24 or newer.

Already using ACC? Follow the [upgrade guide](UPGRADING.md) for the 0.4.x → 0.5.0
update or the data-format boundary when upgrading from 0.3.1.

```bash
npm install -g agents-can-communicate
```

<!-- test:command -->
```bash
acc install
```

Initial installation also enables automatic updates; reinstalling keeps an explicit opt-out.
ACC downloads releases in the background and
refreshes its runtime and skills when active clients have left. Use `acc update` for an
immediate update; an eligible Codex service restart asks for one confirmation. ACC then
handles maintenance and reports progress in `acc doctor`; clients disconnect and can be
resumed afterward. Use `acc update --auto off` to disable background updates. See
[update controls](UPGRADING.md#automatic-updates-after-installation).

The installer connects only the supported clients it finds. Open a new terminal and
restart any running clients so they load their integrations. Follow the activation steps
printed by the installer. In Codex, use `/plugins` to check ACC is enabled, then `/hooks`
to review each ACC hook and enable/trust its current definition if needed. Restart the
session after that review; changed hook definitions may require trust again.

For Codex live delivery, follow the outgoing-permission and local-service instructions
from install/doctor, then start a new session. Default workspace permissions can be
configured automatically on Codex 0.153.4 or newer on macOS arm64. Custom settings are
preserved; see [outgoing permissions](CONFIGURATION.md#codex-outgoing-permissions).
With legacy sandbox settings, the named ACC state directory must also be in
`sandbox_workspace_write.writable_roots` in the config the installer identifies.
ACC keeps those user settings unchanged. Installed files alone do not establish that hooks
are active; `acc doctor` leaves current readiness unverified and directs you to Codex.

Read the delivery summary for each client. Live delivery needs an explicit opt-in and a
verified channel in the current session. Codex can save your choice even when its local
service is not running yet. Declining uses the reported fallback: `acc inbox`, or next-turn
hooks only where the exact client version and platform are certified.

If you opt into Claude Code's experimental idle delivery, check Claude's Channels startup
notice for ACC and accept its development-channel warning when shown. If it reports Channels
unavailable or blocked, a connected MCP server does not make inbound delivery work;
see [troubleshooting](TROUBLESHOOTING.md#i-enabled-live-delivery-but-got-fallback).
The feature is off by default, can spend
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

A second repeatable pattern is review and handoff. Ask the implementing agent to request
review of an identified revision (a commit when Git is available, or named files and
version otherwise) and wait for the verdict. Ask the reviewer to return blocking defects
or approval. If either session must stop, it can leave a durable handoff naming completed
work, remaining work, and blockers. A later session can recover it from history. The
underlying commands are [`acc request`](CLI.md#messages-and-requests), exact
[`acc inbox --message`](CLI.md#inbox-reply-and-acknowledgement),
[`acc reply`](CLI.md#inbox-reply-and-acknowledgement), and
[`acc finish`](CLI.md#handoff).

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

Codex LocalDaemon and Claude Code Channel offer optional native delivery on
Apple Silicon macOS. They are experimental, can spend tokens, and queue messages
until a running turn finishes. Codex requires 0.152.1 or newer, an already-running
LocalDaemon, recorded opt-in and a verified session; start it with your normal
command. A loaded daemon thread can receive messages after its terminal exits.
[Capabilities](CAPABILITIES.md) explains policy, versions and fallback.

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
