# Context-efficient coordination

Status: approved
Date: 2026-08-31

## Problem

ACC currently has three interacting failure modes observed in a real Claude Code
session:

1. A client compaction fires `SessionStart` again with the same harness session
   id. The hook opens a new ACC session and overwrites the binding, leaving the
   previous session open. The roster then contains duplicate stale/online rows.
2. Every turn projects the whole live roster and every peer claim. One direct
   request therefore carried almost 6 KiB of context, while a forensic
   `sync --scope full --json` for the same workspace was 192 KiB. Repeating even
   small projections across a long session consumed substantially more context
   than the useful messages did.
3. The skill tells an agent to recover missed messages with a full sync. That is
   the widest and noisiest read, and its nested response shape is easy to query
   incorrectly. A replied-to request also remains actionable unless the agent
   remembers to acknowledge it separately.

The repeated silent `PostToolUse:Bash hook error` is separate. The installed ACC
Claude adapter does not register a PostToolUse hook. The user's
`cleanup-git-allow.sh` returns status 1 when the last optional project settings
file is absent.

## Decisions

### Resume the bound session after compaction

`SessionStart` first inspects the existing harness binding. If it still names an
open ACC session at the recorded generation, the hook refreshes that session's
heartbeat and process metadata and returns the same identity. It opens a new
session only when the binding is absent, closed, or invalid.

This is not takeover: the generation-bearing local binding is the continuation
token already used by every subsequent hook. No historical records are deleted.

### Ambient context is a trigger, not a workspace dump

The projector emits one short ACC instruction when peers are present. It does
not enumerate the roster or unrelated claims. Detailed text is reserved for:

- messages addressed to this participant;
- direct-request reminders;
- a claim conflict relevant to the current intent or tool target;
- degraded or failed coordination that needs action.

Legacy duplicate sessions are grouped by participant before peer counts are
shown. An actionable item keeps its stable id so the agent can retrieve or
resolve exactly that item.

### Add narrow message operations

`acc inbox` returns only unresolved messages addressed to the current
participant. `acc inbox --message <id>` returns one addressed message and marks
it seen. It never includes the event log, roster, claims, or materialised
workspace snapshot.

`acc reply --message <id> --body <text>` sends a message to the original sender
with `inReplyTo` set and acknowledges the original request in the same service
operation. It rejects messages not addressed to the current participant.

`sync --scope full` remains available for explicit diagnostics and forensics,
but normal coordination guidance no longer recommends it. MCP `acc_sync`
continues returning pending mail for clients released before `acc_inbox`; the
new operation changes guidance, not the compatibility contract.

The projector returns structured ids for the complete message and attention
groups that survived its byte budget. Delivery state advances from those ids,
never by searching rendered peer-controlled text. Session continuation likewise
validates state and semantic generation inside the atomic durable or ephemeral
update rather than trusting a record read before the write lock.
All ephemeral mutations share that writer lock; a legacy adapter without
structured projection metadata receives no message bodies and emits a visible
targeted-inbox warning instead of silently repeating untracked delivery.

### Make the skill selective

The ACC skill triggers whenever hook context mentions ACC. It teaches a small
default protocol:

1. publish intent once, and only update it when scope materially changes;
2. claim only concrete resources before editing;
3. stay silent unless another agent needs a dependency, conflict, direct
   question, decision, or handoff;
4. use `inbox` for message recovery and `reply` for direct requests;
5. use `status` for current coordination and full sync only for debugging.

Messages should contain conclusions, identifiers, and next actions—not logs,
diffs, transcripts, or repeated status narration.

## Success criteria

- Repeating SessionStart for one harness id leaves exactly one open ACC session
  and returns the same generation, without resurrecting a concurrent close or
  replacement.
- A no-action peer-presence projection stays under 200 bytes and contains no
  session-by-session or claim-by-claim listing.
- Overflow directs the agent to a targeted `inbox --message` command, never a
  full sync, and emits no partial recovery command at a deliberately tiny budget.
- Peer text cannot forge delivery of a message omitted by the context budget,
  and legacy MCP sync clients continue receiving pending mail.
- Inbox and reply behavior is covered through core, CLI, MCP, and installed
  package surfaces.
- The actual Claude cleanup hook exits zero when optional project settings do
  not exist.
- The complete check, test, packaging, and installed-artifact gates pass, and
  each corrected gate is shown failing under a deliberate mutation.

## Out of scope

Deleting historical duplicate sessions, changing durable delivery-state names,
automatic semantic compression of message bodies, or inventing a background
coordinator. Peers remain untrusted and ACC still never reads transcripts.
