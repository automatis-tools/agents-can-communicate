# Development artifact: messages left for a session that ended

Captured on October 25, 2026 with Node 26.5.1 and Claude Code 2.1.310 on macOS. This is an
unpublished development artifact, built from `158ca65c9fd88b44c099497b7d379514fcbde65e`.
The package version remains `0.11.1`; existing release records are unchanged. The build
includes `main` after #319; the real-client capture below ran on `40224537`, whose packed code
differs from it only by #319's claim change.

| Artifact | Value |
|---|---|
| Filename | `agents-can-communicate-0.11.1.tgz` |
| Packed size | 613,306 bytes |
| Files | 376 |
| sha256 | `310ee6fc81949c8a341480a4dcdf3daa900e7f95a3fa13699582191dd29317e3` |

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
per participant, with a core test for that case. The capture above was repeated on this
archive, after the review fixes below, with the same results; the notice line now reads
``answer``/``note from e2e-driver waiting for <participant>, whose sessions have ended; read it
with `acc sync --scope history --message <id>` ``.

## Review fixes

A whole-branch review found three defects, each fixed with a test that failed first:

| Finding | Test | Measured |
|---|---|---|
| The peer-written subject appeared in ACC's own voice, outside the quoted peer block | `a message left for an ended session keeps its peer-written subject out of ACC's voice` (security suite) | — |
| More than 64 qualifying messages cycled through the noticed list, 5 notices on every prompt | `notices stop once told, even when more than sixty-four messages qualify` | per-turn counts `5,0,0,…` |
| Every recent message scanned every receipt | — (one pass builds a map) | 20,000 messages and 40,000 receipts: 2,253 ms before, 9.4 ms after; base attention 3.5 ms |
