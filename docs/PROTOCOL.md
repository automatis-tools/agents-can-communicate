# Protocol

The shared vocabulary behind the CLI, the MCP tools, and every adapter: the
objects a workspace stores, the exact fields each record carries, and the
states they move through.

## Identity hierarchy

```text
Workspace
└── Participant
    └── Session (bound to a generation)
        └── optional child Session
```

- `Participant` is one running agent. Two Codex sessions are two
  participants, even in the same directory. `ACC_PARTICIPANT` pins a durable
  name, which is what lets work addressed to an agent survive it restarting.
- `Session` is one live or resumable conversation in one harness. A
  participant may have several sessions, but ownership and claims attach to
  an exact session **generation** — a counter that proves the session
  survived (or didn't) across a resume. A generation gates claim renewal and
  force release; it is never printed by `acc status` — proof, not public
  information.
- A session records the checkout it is working in — `checkoutRoot` and
  `branch`. One workspace spans every worktree of a repository, so the
  workspace id cannot say who is where, and nothing else can: the agents a
  clean-up asks about are the ones not running.
- A session records the process behind it — `pid` — when the hook can name
  one, and `null` when it cannot: no process table on the platform, or an
  ancestry that never resolved. `null` means judge this session by age
  alone; it never means the session is dead.

## Intent

Every active top-level session should publish one current Intent after it
understands the user's request.

```ts
export interface WorkIntent {
  sessionId: string;
  summary: string;
  mode: "observe" | "explore" | "edit" | "review" | "coordinate" | "wait";
  resourceHints: string[];
  state: "active" | "blocked" | "waiting" | "done";
  updatedAt: string;
}
```

Intent is awareness, not authorization. An edit intent does not replace a
claim.

## Resource claims

Claims use resource URIs so the core is not limited to files:

```text
file:game/presentation/**
git:branch/feature-camera
asset:tank-model/v3
doc:architecture#camera-contract
url:https://example.test/spec
```

```ts
export interface ResourceClaim {
  claimId: string;
  workspaceId: string;
  ownerSessionId: string;
  resource: string;
  mode: "shared" | "exclusive";        // default: exclusive
  enforcement: "advisory" | "guarded"; // default: advisory
  reason: string;
  acquiredAt: string;
  expiresAt: string;
  generation: string;
}
```

Adapters may provide path-aware overlap logic, but core mutation is atomic
and project-agnostic. File-path canonicalization and the `file:dir/**`
glob rule are covered in [Concepts](CONCEPTS.md#intent-is-cheap-a-claim-commits).

### Claim lifetime and stale owners

Claims are leases. `expiresAt` bounds every claim — `leaseSeconds` defaults
to 1800 — and renewal requires the owner's exact session generation. A
conflicting claim whose owner session has stale presence still conflicts:
the staleness is reported to the requester, but only lease expiry or an
explicit force release removes the claim. Force release requires human or
policy authority and records actor, reason, and the replaced generation.
Presence staleness alone never auto-releases a claim, because an
idle-but-open session may resume at any moment.

## Messages

Message types are semantic, not vendor-specific:

```text
note
question
answer
contract_request
contract_response
decision_proposal
decision_result
blocker
review_request
review_result
handoff
work_request
```

Every message records sender, recipients, type, priority, reply thread, and evidence
descriptors. Message bodies are
untrusted peer content — a message is data the recipient weighs, never an
order it obeys; see [Concepts](CONCEPTS.md#asking-not-commanding).

## Requesting work

`requestWork` is a message-only convenience. It writes one `work_request` to the named
participant, requires acknowledgement, uses the title as the body when no detail is given,
and returns the message. No separate work record or identifier is created.

## Delivery lifecycle

```text
recorded -> queued -> injected -> seen -> acknowledged
               \-> failed
```

States are monotonic. One recipient's receipt cannot alter another
recipient's state. `seen` means exposed to the receiving session or
explicitly marked, not that the model obeyed it.

`sendMessage` leaves a receipt at `queued`. It advances to `injected` when
the message was actually handed to the recipient — and only then. For a
hooked session that means the turn context carried it: one the budget could
not fit stays `queued` and goes out on a later turn, because a receipt
claiming delivery for text nobody was shown tells the sender something
untrue, and whatever the budget left out is stated in the projection rather
than dropped in silence.

For a client with no hooks, `acc_inbox` is the targeted read: it returns
only unresolved messages addressed to the calling participant, never the
roster, event log, claims, or workspace snapshot, and advances the receipt
to `seen`. An exact id can also recover the injected note named by an
`unread_note` breadcrumb. A non-ack note disappears from the list after it
is read; a direct request remains recoverable while `seen` until
acknowledged.

`replyToMessage` validates that the original was addressed to the caller,
writes an attributed response with `inReplyTo`, and advances the caller's
original receipt to `acknowledged` — answer, link, and acknowledge in one
transaction. Another participant cannot read or answer that receipt.

## Artifacts and handoffs

Artifacts are references with provenance and optional integrity values.
Large content stays outside message bodies.

```ts
export interface ArtifactRef {
  kind: "file" | "git" | "url" | "report" | "image" | "data";
  uri: string;
  description: string;
  sha256?: string;
}
```

A handoff contains:

- goal and status;
- completed work;
- remaining work;
- blockers and unanswered questions;
- claims to release or transfer;
- verification evidence;
- artifacts;
- exact source revision when Git exists.

## Sync and attention

Adapters request deltas since a cursor. Core computes attention items from
six explicit rules — `direct_request`, `claim_conflict`, `request_stalled`,
`claim_expired`, `claim_contended`, `unread_note` — listed with their exact trigger in
[Architecture](ARCHITECTURE.md).

Semantic relevance may be assessed by the receiving model, but correctness
cannot depend on a hidden central LLM classifier.

Sync also supports an explicit full-Workspace scope: any session may
request the complete snapshot — roster, intents, claims, messages, and other
participants' collapsed child sessions — to answer
whole-system forensic questions. Bounded deltas are the ambient default;
one addressed message is always read through `inbox`, never by scanning
this snapshot.
