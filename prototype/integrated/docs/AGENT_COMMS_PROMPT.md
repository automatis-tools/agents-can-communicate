# Local agent-communication bootstrap

You are `<AGENT_ID>` in role `<ROLE>` for task `<TASK>`. Your declared
ownership is `<OWNERSHIP>`. This local transport coordinates parallel work; it
does not replace `AGENTS.md`, `TRACKS.md`, Git, committed contracts, or the
human merge decision.

Before editing files, start the bus and register this exact identity:

```bash
node tools/agents/comms.mjs init
node tools/agents/comms.mjs register --id <AGENT_ID> --role <ROLE> --task <TASK> --ownership <OWNERSHIP>
node tools/agents/comms.mjs inbox --id <AGENT_ID>
node tools/agents/comms.mjs watch --id <AGENT_ID>
```

Run the blocking watcher in a dedicated, long-lived terminal or process and
keep its output visible to you. It maintains presence and prints incoming
events, but its output may not interrupt an active reasoning-turn on this host.
Polling remains mandatory. If `register` fails, or the watcher cannot start and
stay running, stop: **Відмова `register` або неможливість запустити watcher —
блокер** for local parallel work. A solitary read-only session is the only
exception.

Run `node tools/agents/comms.mjs inbox --id <AGENT_ID>` at all of these eight
checkpoints:

1. одразу після `register`;
2. перед першою зміною файлів;
3. після кожної довгої команди або повернення до задачі;
4. перед зміною shared contract;
5. перед commit;
6. перед push/PR;
7. перед переходом до нового етапу;
8. через `wait`, коли агент не має іншої роботи.

Before **any** edit, inspect the inbox and claim the exact scope with `claim`.
Do not edit first and claim later. Respect another agent's live claim and
resolve overlaps before editing. Before a shared-contract edit, request the contract and obtain explicit peer
підтвердження from the relevant peer before changing the shared contract. A
claim is coordination only; it never authorizes work outside `TRACKS.md`.

`reply` sends the substantive response to a message and retains its
`reply_to` link. `ack` records that the recipient has received and handled the
message and archives it; seeing watcher output is not an ack. For every
`action` or `blocker` message, send a `reply` when an answer, progress, or a
reason it remains pending is needed, then `ack` after the required action is
understood or complete. Do not leave required action/blocker messages
unacknowledged.

At the end, create a `handoff` with task/result, branch and base/commit,
changed paths, verification command exit/result evidence, contracts
added/changed/consumed, artifacts with checksums, follow-up owners, and known
limitations. Create that evidence-bearing handoff even when blocked; say what
is blocked and what evidence was obtained. Release claims, stop the watcher
orderly with SIGINT/SIGTERM, then run `close --id <AGENT_ID>`. Never put
secrets, tokens, or credentials in this plaintext local mailbox.
