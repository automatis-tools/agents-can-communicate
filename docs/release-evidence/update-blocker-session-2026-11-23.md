# An update blocker without a client process names its session: development evidence

This records the development candidate for #418. It is not a published release.

## What was seen

On 2026-11-03, during the update from 0.12.2 to 0.14.0, `acc update` and `acc doctor` reported
only "unidentified process (native; 1 native binding; store contract 7; unknown client pid)".
The hold came from a manual Kimi session that recorded no process. It had one heartbeat and no
running Kimi process, and its checkout was the scratchpad of another, closed session. Closing
every open client did not help. Activation waited until `acc detach` closed that session.

The hold itself is expected since #273. The report did not say which session held the update.

## Exact artifact

- Source: clean commit `df5edbed7adc4a1f456c2fe751d97cc48544519c`.
- Archive: `agents-can-communicate-0.15.3.tgz`, 662,767 bytes, 392 files.
- SHA-256: `291ab63c54c1d4b4ab8bbbba73c8c41295fe5babe8c19264ec39c8bbb4648da0`.
- Node 24.4.0, npm 11.4.2, macOS arm64.

The exact archive passed `scripts/verify-package.mjs`.

## Behaviour covered by tests

- A blocking binding without a client pid, whose session records no process, reports the
  session and participant ids, the client, the workspace checkout, the last heartbeat, and the
  time 30 minutes after it. The persisted notice that `acc doctor` shows carries the same text.
  The result holds neither the binding's generation nor its harness key.
- When the session records a live process, the report says the hold lasts until that process
  exits. A session without a checkout is named by its workspace id.
- Past ten blockers, the notice says that `acc update --json` lists the rest; the result carries
  every blocker with its session.
- When the session record cannot be read, the report still names the workspace and says that
  the record is unreadable. It gives no release advice for a session it cannot name.

## Installed run

The archive was installed into an isolated home, data home, npm prefix and cache, with Claude
Code integration installed by `acc install --adapter claude_code`. A manual session from
`acc attach` recorded no process. A native binding for it was written in the 0.12.x shape,
with no client pid and store contract 7. A local registry served the same archive re-versioned
as 0.15.4.

- `acc update --yes` stayed pending and printed: "ACC 0.15.4 is ready; waiting for 1 active or
  unidentified process(es): session session_… (participant manual, cli, workspace workspace_…;
  native; 1 native binding; store contract 7; unknown client pid; last heartbeat
  2026-11-23T02:41:07.698Z; blocks until 2026-11-23T03:11:07.698Z unless it sends a heartbeat).
  To release a session sooner, end it in its client, or have its owner run acc detach; once
  nothing blocks, run acc update or let the automatic update finish."
- `acc doctor` showed the same notice.
- `acc update --yes --json` listed the blocker with its session, participant, client and release
  time.
- Neither output contained the session's generation or the binding's harness key.
- After the owner ran `acc detach`, `acc update --yes` activated 0.15.4.

## Limits

- The installed run used a hand-written binding in the 0.12.x shape, not a Kimi session.
- The report does not add a way to release another owner's session; that stays with its owner
  or its client, or with the presence rule.
