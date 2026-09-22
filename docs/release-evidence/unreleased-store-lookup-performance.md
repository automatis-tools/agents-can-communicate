# Unreleased fast lookups in long-lived workspaces

Found while testing ACC 0.6.0 live on the maintainer's machine: an Antigravity CLI session in
this repository received no ACC context, because every hook exceeded the hook runner's
five-second budget and failed open. The same hooks against an empty data home took 40 to
340 ms, so the cost came from the workspace's accumulated state, not from the adapter.

## Exact local artifact

- Source: clean commit `cadd044302e6382a912a5a08c5ea7e49efcc4079`.
- Archive: `agents-can-communicate-0.6.0.tgz`, packed from that commit.
- Size: 445,146 bytes; 306 packed entries.
- SHA-256: `34f00f69903eb2520db025b65040c52939e5159df6fd8b522926496de82ddd2e`.
- Package version remains `0.6.0`; this is an unpublished development artifact.

The exact archive passed `scripts/verify-package.mjs`: pack, contents, certification
allowlist, packed Markdown links, bundled workspace versions, clean installation, doctor,
no-Git workspace operations, and install/uninstall byte restoration. Syntax checks passed in
589 files.

## What the workspace held, and what one command did

A copy of the workspace (48 MB on disk) was measured in an isolated data home, so the live
store was never written. It held 36 session records, 244 claims, 60 messages, and 7,058
retention markers for 22 delivery bindings - one binding alone had 4,043, one per lease
renewal since it was first published.

- One `acc status` made about 160,000 filesystem calls: every lookup of a delivery binding
  opened and checked every one of its markers, each with a full ancestor walk.
- One Antigravity `PreInvocation` hook listed the session directory 27 times: each session
  lookup read every durable session to find one.

## Measurements on the same copy

| Operation | Before | After |
|---|---|---|
| `acc status` | 4.6-6.6 s | 0.47-0.70 s |
| Antigravity `SessionStart` hook | 5.1 s | 0.84 s |
| Antigravity `PreInvocation` hook | 5.7-8.6 s | 1.3-1.5 s |
| Antigravity `Stop` hook | 6.1 s | 1.1 s |

## Regression evidence

- Renewing a present binding twenty-five times now leaves one marker; before, fifty. A
  delete and republish add exactly one marker each.
- An older marker is never read: unreadable bytes in a superseded marker no longer fail a
  lookup, while an unparsable marker name, or an unknown state in the newest marker, still
  fails closed, and markers are still ordered numerically past their padding.
- A session lookup by id reads that record alone; the shared store contract holds the
  filesystem and in-memory stores to the same `stateRecord` behaviour, including absence
  after removal and for another workspace.

## Limits

Markers already on disk are not removed - the store never unlinks by design - but now cost
one directory listing per lookup. Every state read still validates its full path against the
store root; that is the remaining cost in a large workspace and is deliberate. The
workspace's `tmp/` directory held 11,666 leftover temporary files, which no measured
operation reads; they are not addressed here.
