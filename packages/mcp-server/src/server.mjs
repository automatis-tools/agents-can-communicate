import { AccError, EXIT } from "@agents-can-communicate/protocol";
import { clearSessionBinding, loadSessionBinding, storeSessionBinding }
  from "@agents-can-communicate/adapter-sdk";

import { readResource } from "./resources.mjs";
import { MCP_CAPABILITIES, PUBLIC_TOOLS, RESOURCES } from "./tools.mjs";

export const PROTOCOL_VERSION = "2026-07-28";
export const SUPPORTED_VERSIONS = Object.freeze([PROTOCOL_VERSION]);
const SERVER_INFO = Object.freeze({ name: "agents-can-communicate", version: "0.0.0" });

const META = "io.modelcontextprotocol";
const HEARTBEAT_CADENCE_MS = 60_000;

const complete = result => ({ resultType: "complete",
  _meta: { [`${META}/serverInfo`]: SERVER_INFO }, ...result });

function requireProtocolMeta(params) {
  const meta = params?._meta ?? {};
  const version = meta[`${META}/protocolVersion`];
  const capabilities = meta[`${META}/clientCapabilities`];
  // The revision requires both on every request and mandates -32602 when one is
  // missing. No prior request may be used to supply them.
  if (typeof version !== "string" || capabilities === undefined) {
    throw Object.assign(new Error(
      "each request requires _meta protocolVersion and clientCapabilities"),
    { rpcCode: -32602 });
  }
  if (!SUPPORTED_VERSIONS.includes(version)) {
    throw Object.assign(new Error(`unsupported protocol version: ${version}`),
      { rpcCode: -32022, rpcData: { supported: [...SUPPORTED_VERSIONS] } });
  }
  return { version, capabilities };
}

/**
 * Resolve the ACC session for this server from its own launch configuration.
 *
 * Approved 2026-08-16. The protocol is stateless and forbids treating process or
 * connection identity as session continuity, so the session cannot be anchored
 * to the stdio process. It is derived from the participant and workspace this
 * server was configured with - available identically on every request - and
 * persisted through a binding so a restarted process resolves to the same
 * session instead of creating a second participant.
 */
async function resolveSession(context) {
  const key = `mcp:${context.participantId}:${context.workspaceId}`;
  const existing = await loadSessionBinding({ runtimeDir: context.runtimeDir,
    harnessSessionId: key });
  if (existing !== null) {
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

async function callTool(name, args, context) {
  const session = await resolveSession(context);
  const owner = { sessionId: session.sessionId, generation: session.generation,
    workspaceId: context.workspaceId, descriptor: context.descriptor };
  const service = context.service;

  switch (name) {
    case "acc_sync":
      return service.sync({ ...owner, cursor: args.cursor ?? null, scope: args.scope,
        limit: args.limit });
    case "acc_work":
      return service.setIntent({ ...owner, summary: args.summary, mode: args.mode,
        state: args.state, workstreamId: args.workstreamId ?? null,
        resourceHints: args.resourceHints ?? [] });
    case "acc_claim":
      if (args.action === "release") return service.releaseClaim({ ...owner,
        claimId: args.claimId }) ?? { released: args.claimId };
      if (args.action === "renew") return service.renewClaim({ ...owner,
        claimId: args.claimId, leaseSeconds: args.leaseSeconds });
      return service.acquireClaim({ ...owner, resource: args.resource,
        mode: args.mode ?? "exclusive", enforcement: "advisory",
        reason: args.reason ?? "unspecified", leaseSeconds: args.leaseSeconds });
    case "acc_message":
      return service.sendMessage({ ...owner, toParticipantIds: args.to ?? [],
        subject: args.subject, body: args.body, type: args.type ?? "note",
        priority: args.priority, requiresAck: args.requiresAck === true,
        workstreamId: args.workstreamId ?? null });
    case "acc_task":
      if (args.action === "claim") return service.claimTask({ ...owner, taskId: args.taskId });
      if (args.action === "transition") return service.transitionTask({ ...owner,
        taskId: args.taskId, state: args.state });
      return service.createTask({ ...owner, workstreamId: args.workstreamId,
        title: args.title, taskId: args.taskId, dependsOn: args.dependsOn ?? [] });
    case "acc_finish":
      return service.finishSession({ ...owner, goal: args.goal, status: args.status,
        completed: args.completed ?? [], remaining: args.remaining ?? [],
        blockers: args.blockers ?? [], toParticipantId: args.toParticipantId ?? null });
    default:
      throw new AccError(EXIT.USAGE, `unknown tool: ${name}`, { name });
  }
}

async function handle(message, context) {
  const { method, params } = message;
  if (method === "server/discover") {
    requireProtocolMeta(params);
    return complete({ supportedVersions: [...SUPPORTED_VERSIONS], capabilities: {
      tools: {}, resources: {} }, serverInfo: SERVER_INFO, accCapabilities: MCP_CAPABILITIES });
  }
  requireProtocolMeta(params);
  switch (method) {
    case "tools/list":
      return complete({ tools: [...PUBLIC_TOOLS] });
    case "resources/list":
      return complete({ resources: [...RESOURCES] });
    case "resources/read": {
      const value = await readResource(params.uri, context);
      return complete({ contents: [{ uri: params.uri, mimeType: "application/json",
        text: JSON.stringify(value, null, 2) }] });
    }
    case "tools/call": {
      try {
        const value = await callTool(params.name, params.arguments ?? {}, context);
        return complete({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
          structuredContent: JSON.stringify(value) });
      } catch (error) {
        // A failing operation is a tool result, not a transport failure: the
        // model must see it and be able to react.
        return complete({ isError: true,
          content: [{ type: "text", text: `${params.name}: ${error.message}` }] });
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
        write({ jsonrpc: "2.0", error: { code: -32700, message: "parse error" } });
        continue;
      }
      // Notifications get no reply, by rule.
      if (message.id === undefined || message.id === null) continue;
      try {
        write({ jsonrpc: "2.0", id: message.id, result: await handle(message, context) });
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
