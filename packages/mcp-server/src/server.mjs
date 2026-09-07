import { AccError, EXIT, GENERIC_MESSAGE_KINDS, VALID_OBLIGATIONS }
  from "@agents-can-communicate/protocol";
import { clearSessionBinding, loadSessionBinding, storeSessionBinding }
  from "@agents-can-communicate/adapter-sdk";

import { readResource } from "./resources.mjs";
import { validateToolInput } from "./input-validator.mjs";
import { PUBLIC_TOOLS, RESOURCES } from "./tools.mjs";
import { createProtocol } from "./protocol.mjs";

export { PROTOCOL_VERSION, SUPPORTED_VERSIONS } from "./protocol.mjs";
const HEARTBEAT_CADENCE_MS = 60_000;

/**
 * Resolve the ACC session for this server from its own launch configuration.
 *
 * Approved 2026-08-16. The 2026 interface forbids treating process or
 * connection identity as session continuity, so the session cannot be anchored
 * to the stdio process. It is derived from the participant and workspace this
 * server was configured with - available identically on every request - and
 * persisted through a binding so a restarted process resolves to the same
 * session instead of creating a second participant.
 */
async function resolveSession(context, { forFinish = false } = {}) {
  const key = `mcp:${context.participantId}:${context.workspaceId}`;
  const existing = await loadSessionBinding({ runtimeDir: context.runtimeDir,
    harnessSessionId: key });
  if (existing !== null) {
    if (forFinish) {
      const current = await context.service.locateSession(existing.accSessionId, context.workspaceId);
      // Core validates and closes this exact generation, including retries.
      // A prior heartbeat could race another finish and reopen a different owner.
      if (current !== null
        && current.record.generation === existing.generation) return current.record;
    }
    try {
      return await context.service.heartbeatSession({ sessionId: existing.accSessionId,
        generation: existing.generation, workspaceId: context.workspaceId });
    } catch (error) {
      if (error.code !== EXIT.CONFLICT) throw error;
      // The recorded generation is gone. Clearing before reopening keeps the
      // failure visible instead of silently accumulating bindings.
      await clearSessionBinding({ runtimeDir: context.runtimeDir, harnessSessionId: key });
    }
  }
  const session = await context.service.openSession({
    workspaceId: context.workspaceId,
    participantId: context.participantId,
    displayName: context.participantId,
    harness: "mcp",
    heartbeatCadenceMs: HEARTBEAT_CADENCE_MS,
    descriptor: context.descriptor,
  });
  await storeSessionBinding({ runtimeDir: context.runtimeDir, harnessSessionId: key,
    accSessionId: session.sessionId, generation: session.generation });
  return session;
}

export async function recordAndOffer({ record, router, selectMessage = value => value }) {
  const recorded = await record();
  const message = selectMessage(recorded);
  if (router === null || router === undefined
    || !Array.isArray(message?.toParticipantIds) || message.toParticipantIds.length === 0) {
    return { recorded, delivery: [] };
  }
  try {
    return { recorded, delivery: await router.offer(message) };
  } catch {
    return { recorded, delivery: message.toParticipantIds.map(recipientParticipantId => ({
      recipientParticipantId, outcome: "queued", transport: "durable",
      errorCode: "transport_error",
    })) };
  }
}

const clientMessageId = (args, service) =>
  args.clientMessageId ?? service.ids.next("client");

function obligationFor(kind, explicit, addressed) {
  if (!GENERIC_MESSAGE_KINDS.includes(kind)) {
    const command = kind === "answer"
      ? "acc_reply" : kind === "handoff" ? "acc_finish" : null;
    throw new AccError(EXIT.USAGE, command === null
      ? `unknown message kind: ${kind}` : `${kind} messages require ${command}`);
  }
  const obligation = explicit ?? VALID_OBLIGATIONS[kind][0];
  if (!VALID_OBLIGATIONS[kind].includes(obligation)
    || (!addressed && obligation !== "none")) {
    throw new AccError(EXIT.USAGE,
      `message obligation ${obligation} is invalid for ${kind}`);
  }
  return obligation;
}

/**
 * A poll is this client's turn.
 *
 * The hook runtime hands a session its pending messages when it builds a turn,
 * and marks them delivered. An MCP client has no turn and no hook, and no tool
 * ever handed it anything: it saw a `reply_required` line carrying a subject and
 * an id, and to read what a peer had actually said it had to ask for the whole
 * snapshot and search every message in the workspace for its own name.
 *
 * The receipt never moved either. It stayed `queued` for as long as the client
 * ran, so the sender was told its message had not been delivered by an agent
 * that had answered it.
 *
 * Returning them here is delivery, in the same sense and with the same honesty
 * as the turn: what is handed over is marked `retrieved`, and nothing else is.
 * Acknowledgement stays a separate act, because being shown something is not
 * agreeing to it.
 */
async function callTool(name, args, context) {
  const session = await resolveSession(context, { forFinish: name === "acc_finish" });
  const owner = { sessionId: session.sessionId, generation: session.generation,
    workspaceId: context.workspaceId, descriptor: context.descriptor };
  const service = context.service;

  switch (name) {
    case "acc_status":
      return service.collectStatus({});
    case "acc_sync":
      return service.sync({ ...owner, cursor: args.cursor ?? null,
        scope: args.scope, limit: args.limit });
    case "acc_work":
      if (args.clear === true) {
        await service.clearIntent({ ...owner });
        return { cleared: true };
      }
      return service.setIntent({ ...owner, summary: args.summary, mode: args.mode,
        state: args.state, resourceHints: args.resourceHints ?? [] });
    case "acc_claim":
      if (args.action === "renew") return service.renewClaim({ ...owner,
        claimId: args.claimId, leaseSeconds: args.leaseSeconds });
      return service.acquireClaim({ ...owner, resource: args.resource,
        mode: args.mode ?? "exclusive", enforcement: "advisory",
        reason: args.reason ?? "unspecified", leaseSeconds: args.leaseSeconds });
    case "acc_release":
      await service.releaseClaim({ ...owner, claimId: args.claimId });
      return { released: args.claimId };
    case "acc_message": {
      const kind = args.kind ?? "note";
      const toParticipantIds = args.to ?? [];
      const routed = await recordAndOffer({ router: context.deliveryRouter, record: () =>
        service.sendMessage({ ...owner, clientMessageId: clientMessageId(args, service),
        toParticipantIds, subject: args.subject, body: args.body, kind,
        obligation: obligationFor(kind, args.obligation, toParticipantIds.length > 0) }) });
      const message = routed.recorded;
      return { message, delivery: routed.delivery };
    }
    case "acc_inbox":
      return service.readInbox({ ...owner, messageId: args.messageId });
    case "acc_reply": {
      const routed = await recordAndOffer({ router: context.deliveryRouter,
        selectMessage: value => value.reply,
        record: () => service.replyToMessage({ ...owner, messageId: args.messageId,
          body: args.body, subject: args.subject,
          clientMessageId: clientMessageId(args, service) }) });
      return { message: routed.recorded.reply, receipt: routed.recorded.receipt,
        delivery: routed.delivery };
    }
    case "acc_request": {
      const routed = await recordAndOffer({ router: context.deliveryRouter,
        record: () => service.sendMessage({ ...owner,
          clientMessageId: clientMessageId(args, service),
          toParticipantIds: [args.toParticipantId], kind: "request", obligation: "reply",
          subject: args.title, body: args.detail ?? args.title }) });
      return { message: routed.recorded, delivery: routed.delivery };
    }
    case "acc_ack":
      return service.acknowledgeMessage({ ...owner, messageId: args.messageId });
    case "acc_finish": {
      const routed = await recordAndOffer({ router: context.deliveryRouter,
        selectMessage: value => value.message,
        record: () => service.finishSession({ ...owner,
        clientMessageId: clientMessageId(args, service), goal: args.goal, status: args.status,
        completed: args.completed ?? [], remaining: args.remaining ?? [],
        blockers: args.blockers ?? [], toParticipantId: args.toParticipantId }) });
      return { message: routed.recorded.message, delivery: routed.delivery };
    }
    default:
      throw new AccError(EXIT.USAGE, `unknown tool: ${name}`, { name });
  }
}

async function handle(message, context) {
  const { method, params } = message;
  switch (method) {
    case "tools/list":
      return { tools: [...PUBLIC_TOOLS] };
    case "resources/list":
      return { resources: [...RESOURCES] };
    case "resources/read": {
      // Snapshot and roster are observation-only. Inbox is a delivery boundary:
      // resolve this configured participant's durable session and let the core
      // inbox service record that the returned bodies were retrieved.
      const resourceContext = params.uri === "acc://inbox"
        ? { ...context, session: await resolveSession(context) }
        : context;
      const value = await readResource(params.uri, resourceContext);
      return { contents: [{ uri: params.uri, mimeType: "application/json",
        text: JSON.stringify(value, null, 2) }] };
    }
    case "tools/call": {
      try {
        const args = params.arguments === undefined ? {} : params.arguments;
        const tool = PUBLIC_TOOLS.find(candidate => candidate.name === params.name);
        if (tool === undefined) {
          throw new AccError(EXIT.USAGE, `unknown tool: ${params.name}`, { name: params.name });
        }
        validateToolInput(tool.inputSchema, args);
        const value = await callTool(params.name, args, context);
        return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
          structuredContent: value };
      } catch (error) {
        // A failing operation is a tool result, not a transport failure: the
        // model must see it and be able to react.
        return { isError: true,
          content: [{ type: "text", text: `${params.name}: ${error.message}` }] };
      }
    }
    default:
      throw Object.assign(new Error(`unknown method: ${method}`), { rpcCode: -32601 });
  }
}

/**
 * Newline-delimited JSON-RPC over the given streams. stdout carries protocol
 * messages only; anything the server wants to say goes to stderr.
 */
export async function serve({ input, output, log, context }) {
  const write = value => output.write(`${JSON.stringify(value)}\n`);
  const protocol = createProtocol();
  let buffer = "";

  for await (const chunk of input) {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (line === "") continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        continue;
      }
      // Validate the envelope before accessing fields or treating it as a notification.
      const id = typeof message?.id === "string" || typeof message?.id === "number"
        ? message.id : null;
      if (message === null || typeof message !== "object" || Array.isArray(message)
        || message.jsonrpc !== "2.0" || typeof message.method !== "string"
        || (message.id !== undefined && message.id !== null
          && typeof message.id !== "string" && typeof message.id !== "number")) {
        write({ jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request" } });
        continue;
      }
      // Once the envelope is valid, notifications get no reply, even for invalid params.
      if (message.id === undefined || message.id === null) {
        protocol.notify(message);
        continue;
      }
      if (message.params !== undefined
        && (message.params === null || typeof message.params !== "object")) {
        write({ jsonrpc: "2.0", id, error: { code: -32602, message: "invalid params" } });
        continue;
      }
      try {
        write({ jsonrpc: "2.0", id: message.id,
          result: await protocol.request(message, () => handle(message, context)) });
      } catch (error) {
        log?.(`${message.method}: ${error.message}`);
        write({ jsonrpc: "2.0", id: message.id, error: {
          code: error.rpcCode ?? -32603,
          message: error.message,
          ...(error.rpcData === undefined ? {} : { data: error.rpcData }) } });
      }
    }
  }
}
