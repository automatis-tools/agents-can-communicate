import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { createCoordinationService } from "../src/service.mjs";
import { wouldCycle } from "../src/tasks.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

const NOW = "2026-08-16T01:00:00.000Z";
const WORKSPACE = "workspace_a";

function makeService() {
  const clock = createFakeClock(NOW);
  const store = createMemoryStore({ clock, ids: createFakeIds(), workspaceId: WORKSPACE });
  return { clock, store,
    service: createCoordinationService({ store, clock, ids: createFakeIds() }) };
}

const opening = (overrides = {}) => ({ workspaceId: WORKSPACE, participantId: "participant_a",
  displayName: "visual", harness: "codex", heartbeatCadenceMs: 30_000, ...overrides });

async function workstream(service) {
  const first = await service.openSession(opening());
  const second = await service.openSession(opening({ participantId: "participant_b",
    displayName: "models" }));
  const created = await service.createWorkstream({ sessionId: first.sessionId,
    generation: first.generation, title: "Camera", objective: "Ship the camera contract" });
  return { first, second, workstreamId: created.workstreamId };
}

const authoring = (session, workstreamId, overrides = {}) => ({ sessionId: session.sessionId,
  generation: session.generation, workstreamId, title: "Define slots", ...overrides });

test("a workspace can hold intents without any workstream at all", async () => {
  const { service, store } = makeService();
  const first = await service.openSession(opening());
  const second = await service.openSession(opening({ participantId: "participant_b" }));
  await service.setIntent({ sessionId: first.sessionId, generation: first.generation,
    summary: "exploring", mode: "explore" });
  await service.setIntent({ sessionId: second.sessionId, generation: second.generation,
    summary: "reviewing", mode: "review" });

  const snapshot = await store.snapshot(WORKSPACE);

  // Workstreams and tasks are optional structure, not a precondition for work.
  assert.equal(snapshot.intents.length, 2);
  assert.deepEqual(snapshot.workstreams, []);
  assert.deepEqual(snapshot.tasks, []);
});

test("a new workstream has no coordinator", async () => {
  const { service } = makeService();
  const { first } = await workstream(service);
  const created = await service.createWorkstream({ sessionId: first.sessionId,
    generation: first.generation, title: "Models", objective: "Ship the models" });

  // Nobody becomes coordinator merely by creating the workstream.
  assert.equal(created.coordinatorSessionId, null);
  assert.equal(created.state, "open");
});

test("a coordinator lease is not taken from a live holder", async () => {
  const { service } = makeService();
  const { first, second, workstreamId } = await workstream(service);
  await service.acquireCoordinator({ workstreamId, sessionId: first.sessionId,
    generation: first.generation });

  await assert.rejects(service.acquireCoordinator({ workstreamId,
    sessionId: second.sessionId, generation: second.generation }),
  error => error.code === EXIT.CONFLICT && error.details.coordinatorPresence === "online");
});

test("human authority may replace a coordinator, and release frees the lease", async () => {
  const { service } = makeService();
  const { first, second, workstreamId } = await workstream(service);
  await service.acquireCoordinator({ workstreamId, sessionId: first.sessionId,
    generation: first.generation });

  const replaced = await service.acquireCoordinator({ workstreamId,
    sessionId: second.sessionId, generation: second.generation, authority: "human" });
  assert.equal(replaced.coordinatorSessionId, second.sessionId);

  const released = await service.releaseCoordinator({ workstreamId,
    sessionId: second.sessionId, generation: second.generation });
  assert.equal(released.coordinatorSessionId, null);
});

test("a task with an unmet dependency is created blocked", async () => {
  const { service } = makeService();
  const { first, workstreamId } = await workstream(service);
  const upstream = await service.createTask(authoring(first, workstreamId));

  const downstream = await service.createTask(authoring(first, workstreamId,
    { title: "Use slots", dependsOn: [upstream.taskId] }));

  assert.equal(upstream.state, "pending");
  assert.equal(downstream.state, "blocked");
});

test("completing a dependency unblocks its dependents deterministically", async () => {
  const { service, store } = makeService();
  const { first, workstreamId } = await workstream(service);
  const upstream = await service.createTask(authoring(first, workstreamId));
  const downstream = await service.createTask(authoring(first, workstreamId,
    { title: "Use slots", dependsOn: [upstream.taskId] }));
  await service.claimTask({ taskId: upstream.taskId, sessionId: first.sessionId,
    generation: first.generation });

  await service.transitionTask({ taskId: upstream.taskId, sessionId: first.sessionId,
    generation: first.generation, state: "done" });

  const tasks = (await store.snapshot(WORKSPACE)).tasks;
  assert.equal(tasks.find(task => task.taskId === downstream.taskId).state, "pending");
  const events = (await store.eventsSince(WORKSPACE, null, 50)).events;
  assert.equal(events.some(event => event.type === "task.unblocked"), true);
});

test("a task blocked on two dependencies waits for both", async () => {
  const { service, store } = makeService();
  const { first, workstreamId } = await workstream(service);
  const left = await service.createTask(authoring(first, workstreamId, { title: "Left" }));
  const right = await service.createTask(authoring(first, workstreamId, { title: "Right" }));
  const downstream = await service.createTask(authoring(first, workstreamId,
    { title: "Both", dependsOn: [left.taskId, right.taskId] }));
  const finish = async task => {
    await service.claimTask({ taskId: task.taskId, sessionId: first.sessionId,
      generation: first.generation });
    await service.transitionTask({ taskId: task.taskId, sessionId: first.sessionId,
      generation: first.generation, state: "done" });
  };

  await finish(left);
  const stateOf = async () => (await store.snapshot(WORKSPACE)).tasks
    .find(task => task.taskId === downstream.taskId).state;
  assert.equal(await stateOf(), "blocked");

  await finish(right);
  assert.equal(await stateOf(), "pending");
});

test("a dependency that does not exist is rejected", async () => {
  const { service } = makeService();
  const { first, workstreamId } = await workstream(service);

  await assert.rejects(service.createTask(authoring(first, workstreamId,
    { title: "Ghost", dependsOn: ["task_missing"] })), error => error.code === EXIT.DATA);
});

test("a cycle closed through an explicit task id is rejected", async () => {
  const { service } = makeService();
  const { first, workstreamId } = await workstream(service);
  // A generated id can never close a cycle, because nothing references it yet.
  // A caller-supplied id can, which is the case this guard exists for.
  const anchor = await service.createTask(authoring(first, workstreamId,
    { taskId: "task_anchor", title: "Anchor" }));
  const middle = await service.createTask(authoring(first, workstreamId,
    { taskId: "task_middle", title: "Middle", dependsOn: [anchor.taskId] }));

  await assert.rejects(service.createTask(authoring(first, workstreamId,
    { taskId: "task_anchor", title: "Anchor again", dependsOn: [middle.taskId] })),
  error => error.code === EXIT.DATA
    && error.message.includes("cycle"));
});

test("cycle detection walks the whole dependency chain, not just one hop", () => {
  const tasks = [
    { taskId: "task_a", dependsOn: [] },
    { taskId: "task_b", dependsOn: ["task_a"] },
    { taskId: "task_c", dependsOn: ["task_b"] },
  ];

  assert.equal(wouldCycle(tasks, "task_a", ["task_c"]), true);
  assert.equal(wouldCycle(tasks, "task_d", ["task_c"]), false);
  // A pre-existing cycle must not make the walk loop forever.
  assert.equal(wouldCycle([{ taskId: "task_x", dependsOn: ["task_y"] },
    { taskId: "task_y", dependsOn: ["task_x"] }], "task_z", ["task_x"]), false);
});

test("a task cannot be claimed twice by different sessions", async () => {
  const { service } = makeService();
  const { first, second, workstreamId } = await workstream(service);
  const task = await service.createTask(authoring(first, workstreamId));
  await service.claimTask({ taskId: task.taskId, sessionId: first.sessionId,
    generation: first.generation });

  await assert.rejects(service.claimTask({ taskId: task.taskId, sessionId: second.sessionId,
    generation: second.generation }), error => error.code === EXIT.CONFLICT);
});

test("an illegal task transition is refused by the state machine", async () => {
  const { service } = makeService();
  const { first, workstreamId } = await workstream(service);
  const task = await service.createTask(authoring(first, workstreamId));

  await assert.rejects(service.transitionTask({ taskId: task.taskId,
    sessionId: first.sessionId, generation: first.generation, state: "done" }),
  error => error.code === EXIT.CONFLICT);
});
