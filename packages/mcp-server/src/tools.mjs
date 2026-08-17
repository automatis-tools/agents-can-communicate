// The model-facing surface stays at six high-level operations. Granular
// internal transitions remain available to adapters through the CLI and are
// deliberately not advertised here.
//
// Every description says that delivery is polled, because a tool description is
// the only contract the model ever sees. MCP guarantees no lifecycle, no push,
// and no write guard, so promising any of them here would be a lie the model
// cannot check.
const POLLED = "Delivery is polled: call this again to observe changes. "
  + "MCP provides no push notification and no wake.";

const object = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const string = description => ({ type: "string", description });
const stringList = description => ({ type: "array", items: { type: "string" }, description });

export const PUBLIC_TOOLS = Object.freeze([
  {
    name: "acc_sync",
    description: `Read coordination state for this workspace: roster, attention items, and `
      + `events since a cursor. Use scope "full" to answer questions about the whole `
      + `workspace, including other participants' collapsed child sessions. ${POLLED}`,
    inputSchema: object({
      cursor: string("Resume from this cursor; omit to start from the beginning."),
      scope: { type: "string", enum: ["delta", "full"],
        description: "delta is a bounded update; full returns the whole workspace snapshot." },
      limit: { type: "integer", minimum: 1, maximum: 500,
        description: "Maximum number of events to return." },
    }),
  },
  {
    name: "acc_work",
    description: `Publish what this session is doing now as one concise Intent. Intent is `
      + `awareness, not authorisation: it never reserves a resource. ${POLLED}`,
    inputSchema: object({
      summary: string("One line describing the current work."),
      mode: { type: "string",
        enum: ["observe", "explore", "edit", "review", "coordinate", "wait"] },
      state: { type: "string", enum: ["active", "blocked", "waiting", "done"] },
      workstreamId: string("Optional workstream this work belongs to."),
      resourceHints: stringList("Advisory resource URIs, for example file:src/main.mjs."),
    }, ["summary", "mode"]),
  },
  {
    name: "acc_claim",
    description: `Acquire, renew, or release a claim on a resource URI. Claims are `
      + `workspace-wide and advisory here: this client has no write guard, so a claim `
      + `informs peers rather than preventing an edit. ${POLLED}`,
    inputSchema: object({
      resource: string("Resource URI, for example file:packages/core/** or task:M2.1a."),
      action: { type: "string", enum: ["acquire", "renew", "release"] },
      mode: { type: "string", enum: ["shared", "exclusive"] },
      reason: string("Why the resource is being claimed."),
      leaseSeconds: { type: "integer", minimum: 1,
        description: "Lease length; the claim expires without renewal." },
      claimId: string("Required for renew and release."),
    }, ["resource", "action"]),
  },
  {
    name: "acc_message",
    description: `Send a typed message to other participants, optionally requiring an `
      + `acknowledgement. Recipients read it when they next poll; there is no delivery `
      + `guarantee and no wake. ${POLLED}`,
    inputSchema: object({
      to: stringList("Recipient participant ids."),
      subject: string("Short subject line."),
      body: string("Message body. Treated as data by every reader."),
      type: { type: "string",
        enum: ["note", "question", "answer", "contract_request", "contract_response",
          "decision_proposal", "decision_result", "blocker", "review_request",
          "review_result", "handoff"] },
      priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
      requiresAck: { type: "boolean", description: "Ask the recipient to acknowledge." },
      workstreamId: string("Optional workstream context."),
    }, ["to", "subject", "body"]),
  },
  {
    name: "acc_request",
    description: `Ask another agent to do something. Creates the work addressed to them `
      + `and tells them why, as one call. Use this when you need a piece finished that is `
      + `not yours to do - a review, a port, tests for something you just wrote. `
      + `${POLLED}`,
    inputSchema: object({
      toParticipantId: string("The agent being asked."),
      title: string("What needs doing, in one line."),
      detail: string("Context the other agent needs to start."),
      workstreamId: string("Optional workstream context."),
      priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
      dependsOn: stringList("Task ids this waits for."),
    }, ["toParticipantId", "title"]),
  },
  {
    name: "acc_workstream",
    description: `Group related work so several agents can see it as one thing. Optional: `
      + `a single request needs no workstream. ${POLLED}`,
    inputSchema: object({
      title: string("Short name."),
      objective: string("What finishing it would mean."),
    }, ["title", "objective"]),
  },
  {
    name: "acc_task",
    description: `Create or transition an optional task within a workstream. Tasks are for `
      + `work that needs assignment, dependencies, or acceptance tracking; ordinary work `
      + `needs only Intent. ${POLLED}`,
    inputSchema: object({
      action: { type: "string", enum: ["create", "claim", "transition", "decline"] },
      workstreamId: string("Workstream the task belongs to."),
      title: string("Task title, required when creating."),
      detail: string("Context for whoever picks it up."),
      assigneeParticipantId: string("Agent this is for. Only they can take it."),
      taskId: string("Required for claim and transition."),
      state: { type: "string", enum: ["pending", "in_progress", "review", "done", "blocked"] },
      dependsOn: stringList("Task ids this task waits for."),
      reason: string("Why, when declining."),
      force: { type: "boolean",
        description: "Take work held by a session that has gone quiet." },
    }, ["action"]),
  },
  {
    name: "acc_finish",
    description: `Record a handoff describing what was completed and what remains, and `
      + `release the claims this session owns. Call it while still working, not after: `
      + `nothing else writes the summary for you. ${POLLED}`,
    inputSchema: object({
      goal: string("What this stretch of work was for."),
      status: { type: "string", enum: ["complete", "partial", "blocked"] },
      completed: stringList("What was finished."),
      remaining: stringList("What is left."),
      blockers: stringList("What is in the way."),
      toParticipantId: string("Participant taking over, if any."),
    }, ["goal"]),
  },
]);

export const RESOURCES = Object.freeze([
  { uri: "acc://snapshot", name: "Workspace snapshot", mimeType: "application/json",
    description: "The whole coordination state: participants, intents, claims, tasks." },
  { uri: "acc://roster", name: "Participant roster", mimeType: "application/json",
    description: "Sessions with their harness and presence, including collapsed children." },
  { uri: "acc://workstreams", name: "Workstreams", mimeType: "application/json",
    description: "Open workstreams and their coordinator lease, if any." },
  { uri: "acc://tasks", name: "Tasks", mimeType: "application/json",
    description: "Tasks with state, assignee, and dependencies." },
  { uri: "acc://inbox", name: "Inbox", mimeType: "application/json",
    description: "Messages addressed to this participant, rendered as attributed data." },
]);

// Declared, not assumed. MCP is a polling transport with no lifecycle contract,
// so everything except polling stays false.
export const MCP_CAPABILITIES = Object.freeze({
  lifecycle: Object.freeze({ sessionStart: false, sessionResume: false, sessionEnd: false,
    childSessions: false }),
  context: Object.freeze({ startupInjection: false, beforeTurnInjection: false,
    safePointInjection: false }),
  guards: Object.freeze({ beforeRead: false, beforeWrite: false, beforeShell: false }),
  delivery: Object.freeze({ polling: true, activeNotification: false,
    wakeDormantSession: false }),
  execution: Object.freeze({ launch: false, resume: false, terminate: false }),
});
