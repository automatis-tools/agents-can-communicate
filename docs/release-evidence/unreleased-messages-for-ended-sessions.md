# Development artifact: messages left for a session that ended

Captured on October 25, 2026 with Node 26.5.1 and Claude Code 2.1.310 on macOS. This is an
unpublished development artifact, built from `a7cf5cd935b4da8edcc5c546812a8d3b1181ec36`.
The package version remains `0.11.1`; existing release records are unchanged.

| Artifact | Value |
|---|---|
| Filename | `agents-can-communicate-0.11.1.tgz` |
| Packed size | 612,694 bytes |
| Files | 376 |
| sha256 | `184babc87c406585ac908fbd6f7330c29cb90191de6ca5d7678fec88a56bd8ed` |

`npm pack --json` created the archive. `node scripts/verify-package.mjs` verified
that exact archive and reported PASS, including installed entry points, runtime
enrollment, and install/uninstall restoration. No package was published.

## Before the change

A core reproduction on `main` at `8bfb53f3` (0.11.1): Claude asks Codex for a review,
Codex answers, and the Claude session closes. The answer, an `answer` with obligation
`none`, stays `queued` for the closed session. Attention is empty for a new Claude
session and for Codex.

## Real-client capture

The archive above, installed into an isolated `HOME` and data home (the real Keychains are
linked so that Claude Code is signed in), with Claude Code 2.1.310 in print mode. The ACC CLI
was approved with `--allowedTools`, because print mode cannot ask the user. A CLI participant
`e2e-driver` was the sender. Every later prompt was the same neutral text: "Before you answer,
check whether anything in your context needs your attention and handle it. Then tell me in two
sentences what you found."

| Step | Observed |
|---|---|
| Claude session A answers one prompt and exits | its pid is dead, so its presence is `offline` |
| `e2e-driver` sends A a note with review findings | `queued`, `recipient_offline` |
| New Claude session B | its context carried `[left_for_ended_session] <id>`; it loaded the skill, ran `sync --scope history --message <id>`, and quoted both edge cases |
| B resumed with `--resume` | no notice: the resumed conversation is the same participant |
| New Claude session C | told once, read it the same way, and quoted both edge cases |
| Receipt of the note | still `queued` for A's participant |

The first capture used a once-per-session rule and showed the notice again to the resumed
conversation, which opens another ACC session of the same participant. The rule is now once
per participant, with a core test for that case.
