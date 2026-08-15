# Protocol model

This is the proposed model-facing and adapter-facing domain vocabulary.

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
  id: string;
  title: string;
  objective: string;
  coordinatorSessionId: string | null;
  state: "open" | "paused" | "complete" | "cancelled";
}

export interface Task {
  id: string;
  workstreamId: string;
  title: string;
  state: "pending" | "in_progress" | "review" | "done" | "blocked";
  assigneeSessionId: string | null;
  dependsOn: string[];
  acceptance: string[];
}
```

Dependency completion unblocks tasks deterministically. It must not depend on an LLM remembering to re-evaluate the graph.

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
  id: string;
  workspaceId: string;
  ownerSessionId: string;
  resource: string;
  mode: "shared" | "exclusive";
  enforcement: "advisory" | "guarded";
  reason: string;
  acquiredAt: string;
  expiresAt: string;
  generation: string;
}
```

Adapters may provide path-aware overlap logic, but core mutation is atomic and project-agnostic.

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
```

Every message records sender, recipients, workstream, optional task, priority, reply thread, and evidence descriptors. Message bodies are untrusted peer content.

## Delivery lifecycle

```text
recorded -> queued -> injected -> seen -> acknowledged
               \-> failed
```

States are monotonic. One recipient's receipt cannot alter another recipient's state. `seen` means exposed to the receiving session or explicitly marked, not that the model obeyed it.

## Decisions

Decisions are separate durable objects rather than ordinary chat messages:

```ts
export interface Decision {
  id: string;
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

Adapters request deltas since a cursor. Core computes attention items from explicit rules:

- direct unacknowledged request;
- conflicting claim;
- required task dependency now unblocked;
- coordinator missing while a decision is waiting;
- corrupt or stale ownership state;
- capability failure that weakened protection.

Semantic relevance may be assessed by the receiving model, but correctness cannot depend on a hidden central LLM classifier.
