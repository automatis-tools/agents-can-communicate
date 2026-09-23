# Unreleased certification evidence applies forward

Found while testing ACC 0.6.1 live on the maintainer's machine. An Antigravity CLI session
answered a peer through the relay, and the answer came back to the Claude Code session with
its body withheld: `1 pending message(s) withheld because client 2.1.278 on darwin-arm64 is
not certified for nextTurn`. Both clients were current; the capture set was not.

## Exact local artifact

- Source: clean commit `e99acc7420dd584ad548dbb39e402bf6e09b2ec9`.
- Archive: `agents-can-communicate-0.6.1.tgz`, packed from that commit.
- Size: 446,538 bytes; 306 packed entries.
- SHA-256: `47e93fd4c2c7c5a716c7c47e0f8bb778a1af92e1a971d024144488036ae6f965`.
- Package version remains `0.6.1`; this is an unpublished development artifact.

The exact archive passed `scripts/verify-package.mjs`: pack, contents, certification
allowlist, packed Markdown links, bundled workspace versions, clean installation, doctor,
no-Git workspace operations, and install/uninstall byte restoration. Syntax checks passed in
589 files.

## What the old gate did, measured

`effectiveCapabilities` matched the exact client version and the exact platform. Counting
the shipped evidence against the versions installed on this machine on 2026-09-22:

| Adapter | Evidence it ships | Installed | Effective before | Effective after |
|---|---|---|---|---|
| Claude Code | `nextTurn` 2.1.233; `livePush`/`replyRoute` 2.1.258, 2.1.260 | 2.1.278 | nothing | context, nextTurn, livePush, replyRoute |
| Codex CLI | 0.147.0 hooks; `livePush` 0.152.1, 0.153.4; `livePush`/`replyRoute` fail at 0.152.0 | 0.153.4 | livePush only | context, nextTurn, livePush |
| Gemini CLI | 0.57.0 | 0.59.0, then 0.60.0 | nothing | context, nextTurn |
| Kimi Code | 0.36.1 | 0.42 | nothing | context, nextTurn |
| Antigravity CLI | 1.2.7, plus a `certificationFloor` | 1.2.8 | what the floor named | the same, with no floor field |

Two separate defects sat in that table.

- **Versions.** Claude Code 2.1.260 already lost `delivery.nextTurn`. That capability was
  captured once at 2.1.233, and the 2.1.258 and 2.1.260 captures covered other
  capabilities, so a capture naming one capability silently withdrew every capability it
  did not mention.
- **Platforms.** Every row of every adapter reads `darwin-arm64`, and the platform matched
  exactly. On `linux-x64` and `win32-x64` every capability of every adapter resolved to
  `false`, so ACC placed no message in any context there.

Gemini CLI moved from 0.59.0 to 0.60.0 during the session that wrote this, which is the
argument in one line: a list of exact versions goes stale faster than it can be recorded.

## The rule now

For a client version and platform, each capability resolves independently: keep the rows at
or below that version, prefer the rows naming that platform when there are any, and let the
highest remaining version decide. Every row at the deciding version must pass, so a
recorded loss wins a tie between platforms. A prerelease is ordered by its release triple,
and a version that cannot be read reaches every row.

What stays off: a client older than every capture, and a capability whose deciding row
records a failure. `2.1.252 livePush fail` still turns Claude Code's live push off at
2.1.252 and the 2.1.258 capture turns it back on - the format already expressed regressions
and still does.

## Receipts

Unchanged. A capability that resolves to `false` still withholds bodies and leaves receipts
`queued`, and nothing is marked delivered on a guess. What changed is which clients that
describes.

## Known gap

The 2026-09-13 client survey observed Kimi 0.42 losing `PostToolUse` context, and no
capture exists at 0.42, so Kimi 0.42 inherits the 0.36.1 rows here. Recording that loss
needs its own capture and is tracked separately.
