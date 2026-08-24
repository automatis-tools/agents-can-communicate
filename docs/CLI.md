# CLI

Every command takes `--json` for machine output and `--cwd` to pick the workspace.

```mermaid
graph LR
  subgraph You
    I[acc install] --- D[acc doctor] --- CF[acc config] --- UN[acc uninstall]
  end
  subgraph Your agent
    W[acc work] --- CL[acc claim] --- RQ[acc request] --- MS[acc message] --- TK[acc task] --- WS[acc workstream] --- FN[acc finish] --- ST[acc status] --- SY[acc sync] --- RL[acc release]
  end
  subgraph Adapters only
    AT[acc attach] --- HB[acc heartbeat] --- DT[acc detach]
  end
```

## Setup

| Command | Does |
|---|---|
| `acc install` | Install adapters for the clients on this machine |
| `acc install --dry-run` | Print the exact plan, change nothing |
| `acc install --adapter kimi` | One client only |
| `acc uninstall` | Remove what ACC wrote, keep what you edited |
| `acc doctor` | Clients, versions, install health, what to run next |
| `acc doctor --repair` | Repair store state; refuses if it is ambiguous |
| `acc config init` | Write `acc.workspace.json` after showing it |
| `acc config validate` | Read-only check |

## In a session

| Command | Does |
|---|---|
| `acc status` | Who is here, claims, protection level. `--all` adds everyone who has been |
| `acc sync` | New events since a cursor; silent when alone |
| `acc work` | Publish what this session is doing. `--clear` when it has stopped |
| `acc claim` | Reserve a resource. Exit `5` on conflict |
| `acc release` | Give it back |
| `acc ack` | Answer a message that asked for one, so it stops asking |
| `acc message` | Send a typed message to participants |
| `acc request` | Ask another agent to do something. One call: the work plus why |
| `acc task` | Create work, `--take` it, or `--state` it along |
| `acc workstream` | Group related work. Optional. `--take` / `--release` steer one |
| `acc finish` | Write the handoff and release claims |

## Adapters only

`acc attach`, `acc heartbeat`, `acc detach` — driven by hooks, not by people.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | ok |
| 2 | usage |
| 3 | timeout |
| 4 | data |
| 5 | conflict — someone holds the claim |
| 6 | attention |

## Ownership arguments

Anything that mutates acts as a session, and proves it with that session's generation —
which is what stops a restarted process from acting as the old one. You do not pass
either. `acc` works out which session is running it, from the binding the adapter wrote
when the session started:

| It uses | When |
|---|---|
| `--session` and `--generation` | you passed them — adapters and scripts do |
| `--session` alone | you have an id from `acc status --json`; the rest is looked up |
| the client's own session id in the environment | the client exports one, under any name |
| the checkout you are in | several sessions here, each in its own worktree |
| the only live session | you are the only one attached |

If two live sessions in one checkout both fit, it stops and names them rather than
guessing — acting as the wrong session is exactly what the generation prevents.

The generation is never printed by `acc status`, on purpose: it is proof of ownership, not
public information.

## Who has been here

`acc status` lists the sessions that are present. A closed session is kept — a message is
attributed to whoever sent it, and the roster is the only place that answers which checkout
an agent was working in, which is a question its session cannot answer once it has gone.

```bash
acc status --all
```

That is how a cleanup asks: each entry carries `checkoutRoot`, `branch` and `presence`, so
a worktree with no live session behind it can be told apart from someone's desk.

## Asking another agent

`--to` and `--assignee` name a participant from the roster. One nobody here has is refused
rather than accepted: a message to a name that does not exist used to report `sent` and go
nowhere, and a request made a task assigned to nobody that its author then waited on. A
participant who has closed their terminal is still a participant — that is the whole reason
work is addressed to one.

```bash
acc request --to claude_code --title "finish the store tests" \
  --detail "I ported src/store but ran out of time on the concurrency cases."
```

Finishing the task answers the request it came from, so the message stops demanding an
acknowledgement. `acc ack --message <id>` does the same for messages that are not tied to a
task — and a session can only mark its own receipt, since reading something is a statement
only the reader can make.

One write. The recipient learns about it twice, and the two facts are different: the work
appears as an attention item addressed to them, and the message explains why. A task with
no message is work nobody understands; a message with no task is a request nothing tracks.

Work is addressed to a **participant**, not a session. The agent can close its terminal and
the next session it opens is still told. Only that participant can take it:

```bash
acc task --task task_x --take     # exit 5 if it is not yours
acc task --task task_x --state review
```

`--assignee` on `acc task` addresses work without sending a message. `acc request` is the
same thing with the explanation attached, which is almost always what you want.

A workstream is optional. `acc request --to models --title "review the migration"` needs no
project around it. Create one when several pieces belong together:

```bash
acc workstream \
  --title "Storage" --objective "port the store and its tests"
```

An open workstream with nobody steering it raises `coordinator_missing` for everyone, every
turn, until somebody takes it on. Taking it is saying so; releasing it asks again.

```bash
acc workstream --workstream workstream_x --take
acc workstream --workstream workstream_x --release
```

Only the session holding the lease can hand it back.
