# Idle and working sessions reported as broken

Issues #209, #210 and #215. Measured on ACC 0.8.1, 2026-09-27, with Claude Code 2.1.283,
Codex 0.157.1, Antigravity CLI 1.2.12 and Grok 1.0.41 sessions open in one workspace.

## What was seen

Two clocks move only on a turn: the heartbeat (a session is `stale` after three 60-second
cadences) and the delivery lease (120 seconds). The router treats both as a cache: for a
lapsed lease it verifies the receiver again and refreshes the lease before it offers. Three
readers treated them as a verdict:

- `acc doctor` marked every session with a lapsed lease `degraded` without asking the
  receiver, reported the adapter as `channel unreachable`, and advised starting a new client
  session.
- `acc status` and doctor counted every stale session as "not answering".
- The mid-turn heartbeat ran only after the write guard found a file target, so a turn spent
  in shell commands went stale three minutes in.

A question sent to each idle peer disproved the reports: Claude Code and Codex, both called
`degraded`, answered within 12 seconds.

`docs/DESIGN_DECISIONS.md` keeps "an idle session is honestly reported `stale`" and rejects
a sidecar that fakes liveness. This design keeps that decision. It changes what is concluded
from `stale`, not how often the clocks move.

## Decisions

1. **Doctor asks the receiver whenever a binding exists.** The re-verification is the
   router's own, read-only, bounded at 750 ms. A verified receiver behind a lapsed lease is
   `idle, lease lapsed; receiver verified; the next send refreshes it`. A refusal is
   `degraded` and names its reason. An adapter with no re-verification keeps the old answer,
   because the router cannot refresh its lease either. A verified session lifts the adapter
   line to `local transport active`, which also removes the restart advice.
2. **A stale session is described by what a message meets.** Core adds three facts per
   status row: `processTracked` (the pid is known), `liveDelivery` (a live binding exists)
   and `liveLeaseCurrent` (its lease is valid). Core stays vendor-free; the CLI reads
   next-turn support and re-verification from the adapter registry, and counts a session as
   wakeable on the router's rule: a valid lease, or a lapsed one the adapter can re-verify
   (review of #216). Chosen wording (Mykola, 2026-09-27, "Compact"):
   `5 live (2 idle, wake on send; 1 idle until next turn; 1 idle, inbox only)`.
   "not answering" stays for a stale session with no known process, and
   "N present, none answering" when every live session is such.
3. **A shell-only turn heartbeats.** The no-target branch of `beforeTool` reads the session's
   own record and heartbeats when one is due, under the existing at-most-twice-a-cadence
   rule. The Claude Code matcher is unchanged (`Write|Edit|Bash`): widening it would start a
   hook process for every read.

## Out of scope, filed separately

- #211: whether `recipient_unavailable` can fire for a recipient a live push can wake. The
  live test did not reproduce it.
- #212: Codex session presence follows the app-server daemon pid, not the TUI.
- #213: Codex's sandbox blocks live delivery to Claude Code inbox sockets.
- #214: Antigravity asks approval for every ACC command, so a wake stalls unattended.
