# Protocol

The domain vocabulary shared by models, adapters, and the CLI. Field names below are the
ones the records actually carry.

## Identity hierarchy

```text
Workspace
└── Participant
    └── Session
        └── optional child Session
```

- `Participant` is a persistent logical identity such as a named Codex role or human operator.
- `Session` is one live or resumable conversation in one harness.
- A participant may have several sessions, but ownership and claims are attached to an exact session generation.

## Intent

Every active top-level session should publish one current Intent after it understands the user's request.

```ts
export interface WorkIntent {
  sessionId: string;
  summary: string;
  mode: "observe" | "explore" | "edit" | "review" | "coordinate" | "wait";
  resourceHints: string[];
  workstreamId: string | null;
  state: "active" | "blocked" | "waiting" | "done";
  updatedAt: string;
}
```

Intent is awareness, not authorization. An edit intent does not replace a claim.

## Workstreams and tasks

Workstreams group related collaboration. Tasks are optional and appear only when formal assignment, dependency, or acceptance tracking adds value.

```ts
export interface Workstream {
  workstreamId: string;
  title: string;
  objective: string;
  coordinatorSessionId: string | null;
  state: "open" | "paused" | "complete" | "cancelled";
}

export interface Task {
  taskId: string;
  workstreamId: string | null;        // optional: a request needs no project
  title: string;
  detail: string | null;
  state: "pending" | "in_progress" | "review" | "done" | "blocked";
  assigneeParticipantId: string | null;  // who it is for, survives their restart
  assigneeSessionId: string | null;      // who is doing it now, dies with the process
  dependsOn: string[];
  acceptance: string[];
}
```

A task whose dependencies are unmet is created `blocked`. Finishing the last dependency flips
its dependents to `pending` in the same transaction, so `pending` always means ready and no
LLM has to remember to re-evaluate the graph. A dependency that would close a cycle is
refused.

## Generic resource claims

Claims use resource URIs so the core is not limited to files:

```text
file:game/presentation/**
git:branch/feature-camera
task:M2.1a
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

Adapters may provide path-aware overlap logic, but core mutation is atomic and project-agnostic.

### Claim lifetime and stale owners

Claims are leases. `expiresAt` bounds every claim — `leaseSeconds` defaults to 1800 — and renewal requires the owner's exact session generation. A conflicting claim whose owner session has stale presence still conflicts: the staleness is reported to the requester, but only lease expiry or an explicit force release removes the claim. Force release requires human or policy authority and records actor, reason, and the replaced generation. Presence staleness alone never auto-releases a claim, because an idle-but-open session may resume at any moment.

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

Every message records sender, recipients, workstream, optional task, priority, reply thread, and evidence descriptors. Message bodies are untrusted peer content.

## Requesting work

`requestWork` writes a task and a message in one transaction. Apart they are useless: a task
nobody was told about is work nobody knows exists, and a message describing work that was
never recorded is a request with nothing to point at.

Two assignee fields, because they answer different questions. `assigneeParticipantId` is who
the work is for and outlives that agent restarting — the next session of that participant is
told about it. `assigneeSessionId` is who is actually doing it, and dies with the process.
One field asked to be both would either lose the request when a terminal closes or claim a
dead session is still working.

Only the named participant may take an addressed task. A task with no assignee is open to
anyone, which is what makes a request without a recipient a request to the room.

## Delivery lifecycle

```text
recorded -> queued -> injected -> seen -> acknowledged
               \-> failed
```

States are monotonic. One recipient's receipt cannot alter another recipient's state. `seen` means exposed to the receiving session or explicitly marked, not that the model obeyed it.

`sendMessage` leaves a receipt at `queued`. It advances to `injected` when a recipient's
turn context actually carried the message — and only then. A message the context budget
could not fit stays `queued` and goes out on a later turn, because a receipt claiming
delivery for text nobody was shown tells the sender something untrue. Whatever the budget
left out is stated in the projection rather than dropped in silence.

## Decisions

Decisions are separate durable objects rather than ordinary chat messages:

```ts
export interface Decision {
  decisionId: string;
  workstreamId: string | null;
  title: string;
  outcome: string;
  authority: "human" | "workstream" | "policy";
  decidedBy: string[];
  evidence: ArtifactRef[];
  supersedes: string | null;
  decidedAt: string;
}
```

Peer proposals never become human-authority decisions without an explicit human or policy transition.

## Artifacts and handoffs

Artifacts are references with provenance and optional integrity values. Large content stays outside message bodies.

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

Adapters request deltas since a cursor. Core computes attention items from four explicit
rules — `direct_request`, `claim_conflict`, `task_unblocked`, `coordinator_missing` — listed
with their exact trigger in [ARCHITECTURE.md](ARCHITECTURE.md).

Semantic relevance may be assessed by the receiving model, but correctness cannot depend on a hidden central LLM classifier.

Sync also supports an explicit full-Workspace scope: any session may request the complete snapshot — roster, intents, workstreams, tasks, claims, and other participants' collapsed child sessions — to answer whole-system questions. Bounded deltas are the ambient default; the full scope exists so no session ever has to say it cannot see the rest of the system.
