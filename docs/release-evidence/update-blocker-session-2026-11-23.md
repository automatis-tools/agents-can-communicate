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

- Source: clean commit `500c3c8fc57c29ec382c14006a45169475f20282`.
- Archive: `agents-can-communicate-0.15.3.tgz`, 662,722 bytes, 392 files.
- SHA-256: `7a6da6c41c9dba303f42b6fadeb57427c5a4c30b83dccfe40de7daca8d17a994`.
- Node 24.4.0, npm 11.4.2, macOS arm64.

The exact archive passed `scripts/verify-package.mjs`.

## Behaviour covered by tests

- A blocking binding without a client pid, whose session records no process, reports the
  session and participant ids, the client, the workspace checkout, the last heartbeat, and the
  time 30 minutes after it. The persisted notice that `acc doctor` shows carries the same text.
  The result holds neither the binding's generation nor its harness key.
- When the session records a live process, the report says the hold lasts until that process
  exits. A session without a checkout is named by its workspace id.
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
  2026-11-23T02:20:25.999Z; blocks until 2026-11-23T02:50:25.999Z unless it sends a heartbeat).
  To release a session sooner, end it in its client, or have its owner run acc detach; once
  nothing blocks, run acc update or let the automatic update finish."
- `acc doctor` showed the same notice.
- Neither output contained the session's generation or the binding's harness key.
- After the owner ran `acc detach`, `acc update --yes` activated 0.15.4.

## Limits

- The installed run used a hand-written binding in the 0.12.x shape, not a Kimi session.
- The report does not add a way to release another owner's session; that stays with its owner
  or its client, or with the presence rule.
