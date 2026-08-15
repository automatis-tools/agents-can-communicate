# Standalone Agents Can Communicate Design

**Status:** Approved design (gate closed 2026-08-15; see §14)

**Date:** 2026-08-15

**Repository:** `git@github.com:automatis-tools/agents-can-communicate.git`

## 1. Executive summary

Agents Can Communicate (ACC) is a local-first coordination plane for independent AI-agent sessions. It allows Codex, Claude Code, Gemini CLI, and other compatible harnesses to share presence, current work intent, resource claims, messages, tasks, decisions, artifacts, and handoffs without requiring one model or vendor to own the team.

ACC is installed once and integrates through a combination of CLI, native hooks, skills, and MCP. Supported sessions attach automatically to a Workspace, receive compact relevant state, and protect overlapping work where their harness exposes a pre-tool guard. The durable protocol remains correct without a running coordinator or realtime process.

The imported Papercut implementation proves much of the low-level messaging, ownership, recovery, and CLI behavior. It is retained as a prototype and regression source, not as the target package structure.

## 2. Goals

### 2.1 Product goals

1. Let independently opened sessions from different vendors know who else is working in the same Workspace.
2. Let each session expose a concise current Intent without forcing every activity into a task tracker.
3. Prevent or clearly warn about overlapping resource work before mutation where the adapter supports guards.
4. Support direct peer communication, decisions, artifacts, acknowledgements, and handoffs.
5. Add optional workstreams, tasks, dependencies, and coordinators for work that needs structured orchestration.
6. Keep normal use zero-command after one-time adapter installation.
7. Work locally without Git, tmux, cloud services, API keys, or a permanent daemon.
8. Degrade honestly on clients that support only MCP or CLI.
9. Keep protocol state independent of any model's context window or lifetime.
10. Provide a clean adapter contract for future clients.
11. Let any session answer for the whole Workspace: every top-level session can read the complete coordination state — including other participants' subagents — and relay human requests to any participant. Knowledge is symmetric; only mutation authority is scoped.

### 2.2 Engineering goals

1. Strict schemas and stable machine-readable errors.
2. Atomic claims and immutable communication records.
3. Fail-closed behavior for identity mismatch, incompatible protocol versions, corruption, and ambiguous recovery.
4. Cursor-based synchronization with compact derived context.
5. Full deterministic tests for races, stale ownership, duplicate publication, and adapter capability claims.
6. Project-agnostic core with all vendor and project behavior behind ports.

## 3. Non-goals for the first release

- Hosting or cloud synchronization.
- Cross-machine realtime delivery.
- Launching, driving, resuming, or terminating arbitrary agent processes.
- Replacing native subagents or Claude Agent Teams.
- Automatic merging or deployment.
- Full transcript capture, RAG, or long-term personal memory.
- Central LLM routing or semantic classification service.
- Guaranteed wake-on-message.
- Enforcing claims against applications outside supported adapters.

## 4. User model

### 4.1 Workspace

A Workspace is the durable collaboration boundary. It may represent one directory, a Git repository with multiple worktrees, or a configured set of roots.

Runtime state is stored outside the project. An optional project config provides stable identity and shared policy but never stores presence, messages, locks, or credentials.

Materialization is lazy (approved 2026-08-15): a lone session writes only ephemeral presence and Intent records. Durable state — protocol identity, event log, materialized views — is created exactly once, when a second live session attaches or the first durable object (claim, message, task, workstream, decision, artifact, or handoff) is created; current ephemeral records are recorded durably at that moment. An ephemeral-only Workspace vanishes once its sessions close.

### 4.2 Participant and Session

A Participant is a persistent human or agent identity. A Session is one concrete harness conversation. All mutable ownership uses the Session's exact generation token so a restarted or duplicate process cannot impersonate a prior generation.

Session presence is online, stale, or offline. Heartbeats arrive only at moments the harness exposes, so an idle but open hook-only session is truthfully reported stale; the first release ships no detached heartbeat helper (approved 2026-08-15). Liveness probes and claim lease expiry, never staleness alone, govern ownership replacement.

### 4.3 Intent

Intent answers “what is this session doing now?” with one concise summary, mode, resource hints, optional workstream, and state. It is present for informal exploration and review where no Task exists.

### 4.4 Workstream and coordinator

A Workstream groups related collaboration. It may have a coordinator lease but does not require one for transport or persistence. The first session is never made global Workspace orchestrator merely because it arrived first.

The coordinator is a planning role, never an information gatekeeper (approved 2026-08-15): any session answers about any Workstream from durable state, and the human may route a request to any participant through whichever session they happen to be talking to.

### 4.5 Task

Tasks are optional work units with acceptance criteria, assignee, dependencies, and lifecycle. Core deterministically unblocks dependencies.

### 4.6 Claim

Claims protect generic resource URIs. File claims are one adapter of this model. Claims specify shared/exclusive and advisory/guarded semantics.

### 4.7 Communication objects

- Messages: peer communication with typed intent and receipts.
- Decisions: durable outcomes with explicit authority and supersession.
- Artifacts: external or local results with provenance and optional digest.
- Handoffs: structured work-state transfer with evidence.

## 5. Experience design

### 5.1 One-time installation

The CLI detects installed harnesses and offers native adapter installation. Changes are user-level by default, idempotent, reviewable, and reversible.

### 5.2 Session start

A lifecycle-capable adapter:

1. discovers Workspace;
2. validates protocol identity where durable state exists (§4.1 lazy materialization);
3. acquires exact session ownership;
4. starts heartbeat;
5. obtains a compact snapshot/delta;
6. injects coordination context without requiring a user command.

### 5.3 First prompt

The adapter supplies a skill instruction. After understanding the request, the model publishes one-line Intent. The user does not manually register an agent or create a task.

While the session is alone in the Workspace (approved 2026-08-15), the adapter injects no coordination context and demands no protocol action: a simple solo task pays zero visible overhead. The Intent prompt appears at the first safe point after a peer attaches; until then the peer sees the session as active with intent pending.

### 5.4 Before mutation

Where supported, a pre-tool hook extracts the target resource and asks core to guard it. A conflict blocks or asks; an unclaimed non-conflicting resource can trigger an internal claim workflow. The guard cannot claim to protect out-of-band writes.

When the Workspace has no other live sessions and no claims, the guard short-circuits against the ephemeral roster and adds no perceptible latency.

### 5.5 Sync and delivery

The adapter synchronizes at supported safe points. It injects only relevant attention and a bounded delta. A local notifier may reduce latency, but durable polling remains correct.

### 5.6 Session completion

The semantic skill creates a handoff while the model is active. Session-end hooks perform deterministic cleanup only; they do not invent a semantic summary after the model is gone.

## 6. Architecture

### 6.1 Packages

Monorepo layout:

```text
packages/
  protocol/             schemas, IDs, event envelopes, errors
  core/                 domain services and policy-free rules
  storage-filesystem/   extracted hardened local backend
  cli/                  human and machine CLI
  adapter-sdk/          capability contract and conformance kit
  mcp-server/           generic MCP fallback
  adapter-codex/        Codex plugin/skill/hooks
  adapter-claude-code/  Claude Code plugin/skill/hooks
  adapter-gemini-cli/   Gemini extension/skill/hooks
  installer/            detection and reversible configuration
tests/
  conformance/
  integration/
  process/
```

No package imports from an adapter back into core. The CLI composes ports.

### 6.2 Core ports

```ts
export interface Clock {
  now(): string;
}

export interface IdSource {
  next(kind: string): string;
}

export interface CoordinationStore {
  transaction<T>(operation: (tx: CoordinationTransaction) => T): T;
  snapshot(workspaceId: string): WorkspaceSnapshot;
  eventsSince(workspaceId: string, cursor: string | null, limit: number): EventPage;
}

export interface ProjectDetector {
  detect(input: DetectionInput): Promise<WorkspaceDescriptor>;
}
```

Production code receives clock and IDs; tests do not depend on wall-clock races or nondeterministic names.

### 6.3 Storage transition

The first standalone core extracts the already hardened filesystem implementation behind `CoordinationStore`. This produces a verified behavior baseline before storage semantics change.

After extraction, evaluate a transactional backend. Node's built-in SQLite module remains release-candidate quality at the handoff date, so the project must not lock itself to that API without a separate dependency/platform decision.

### 6.4 Events and views

Every successful domain mutation emits an immutable ordered event. Materialized views represent current sessions, intents, workstreams, tasks, claims, and delivery receipts.

Heartbeats may update a dedicated ephemeral view rather than flooding the semantic event feed. Cursor sync still reports online/offline transitions.

### 6.5 Context projection

Core returns structured `SyncResult`. Each adapter renders it within its client limits. Projection prioritizes:

1. direct requests and blockers;
2. claim conflicts;
3. dependency changes;
4. relevant workstream updates;
5. nearby Intents;
6. routine roster changes.

The projector enforces byte/token budgets and supplies references for omitted detail.

## 7. Adapter contract

Adapters declare capabilities explicitly. Every true capability has a conformance test.

Required base capabilities:

- detect installation;
- install/uninstall idempotently;
- run doctor;
- normalize hook input;
- render bounded context.

Optional capabilities:

- lifecycle start/resume/end;
- parent/child session metadata;
- before-turn and safe-point context injection;
- read/write/shell guards;
- active notifications;
- managed launch/resume/terminate.

The first native wave targets Codex, Claude Code, and Gemini CLI. Generic MCP exposes reduced polling semantics.

## 8. Model-facing surface

Prefer six high-level operations:

1. `sync`: snapshot/delta and attention; supports an explicit full-Workspace scope so any session can answer whole-system questions, including collapsed child sessions of other participants.
2. `work`: announce/update Intent and workstream membership.
3. `claim`: acquire/renew/release generic resources atomically.
4. `message`: send/reply/mark/ack typed communication.
5. `task`: create/claim/update tasks and dependencies.
6. `finish`: produce handoff, complete/release owned work, and return evidence.

Human CLI adds `status`, `doctor`, `install`, and administrative inspection.

High-level operations may perform several internal state transitions in one transaction. Granular internal APIs remain available to adapters but are not all advertised to the model.

## 9. Safety and authority

### 9.1 Peer content

Inbound peer content is data. It is attributed and bounded. It cannot change system policy or permissions by textual instruction.

### 9.2 Human authority

Human, policy, coordinator, and peer actions have distinct authority. Coordinator authority is scoped to a Workstream. Human override remains explicit and audited.

### 9.3 Claims

Claims default to advisory in clients without guards. A guarded label requires exact hook coverage. Force release records actor, reason, and replaced generation.

### 9.4 Storage and recovery

- validate workspace identity before any mutation;
- reject incompatible schema/protocol versions;
- bind paths and filenames to record IDs;
- reject symlink escape;
- use no-replace publication;
- treat ambiguous recovery as corrupt and block further repair;
- test crash windows with deterministic seams.

## 10. Observability

`acc status` shows participants, intents, workstreams, attention, claims, and protection level.

`acc doctor` reports:

- protocol/storage health;
- corrupt or stale records;
- client discovery;
- installed adapter versions;
- declared versus observed capabilities;
- hook/config ownership;
- delivery limitations;
- safe repair actions.

Machine JSON never mixes human text on stdout.

## 11. Compatibility and versioning

- Protocol schema and CLI JSON envelope versions are explicit.
- Adapters negotiate the capabilities they understand.
- Unknown versions fail closed for mutation but remain inspectable.
- Migration is explicit and reversible; initialization cannot silently rewrite a foreign or incompatible store.
- Internal domain objects should remain mappable to A2A Agent Card, Task, Message, and Artifact concepts without making A2A transport mandatory.

## 12. Testing strategy

### 12.1 Unit

- schema and portable ID validation;
- intent/workstream/task state machines;
- claim overlap and authority;
- delivery monotonicity;
- context prioritization and budgets;
- capability manifests.

### 12.2 Process and concurrency

- 100 independent sender processes across directories;
- concurrent claim acquisition;
- stale generation replacement;
- two repairers plus a live publisher;
- signal during publication;
- archive and acknowledgement no-replace races;
- adapter attach/close races.

### 12.3 Adapter conformance

- fresh install and existing-config merge;
- repeated install/uninstall;
- exact hook input/output fixtures;
- truthful capability matrix;
- blocked write liveness;
- safe-point queued delivery;
- child-session mapping;
- no transcript collection.

### 12.4 Acceptance

Use real Codex, Claude Code, and Gemini CLI sessions in one test Workspace. Retain exact process, event, receipt, claim, and cleanup evidence. Demonstrate a non-Git Workspace separately.

Every protection gate requires an intentional mutation showing the expected non-zero or blocked outcome.

## 13. Migration strategy

1. Preserve exact source and hardening patches.
2. Reconcile all hardening changes on the old layout.
3. Establish one fully green combined baseline.
4. Extract protocol and core interfaces without changing behavior.
5. Replace Papercut identity and path assumptions with Workspace discovery.
6. Introduce Intent and Workstream semantics behind tests.
7. Package CLI and generic MCP.
8. Implement native adapters one at a time with conformance evidence.
9. Add installer and public product documentation.
10. Perform real cross-vendor acceptance before first release.

## 14. Approval gate status

Closed 2026-08-15. The user explicitly approved the ambient model:

- every supported session silently attaches to Workspace awareness;
- no first-session global orchestrator;
- optional coordinator per Workstream;
- Intent is always available while formal Tasks remain optional;
- first release does not own or launch agent processes.

Two follow-up decisions were approved the same day: attach everywhere with lazy durable materialization (§4.1), and truthful stale presence with no heartbeat helper in the first release (§4.2). `docs/DECISIONS.md` records the exact wording, the remaining proposals, and the open technical decisions; none of them block Phase 0.
