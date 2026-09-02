#!/usr/bin/env node
// The ACC Channel binary Claude Code spawns as a stdio MCP child. It composes
// the same workspace discovery, session binding, core service, and local
// data-home rules as acc-hook, opens a session-scoped endpoint for the delivery
// router, and turns the model's explicit acc_reply / acc_ack into real ACC
// records. It never collects a transcript or runs a model, and it fails open:
// any composition error leaves Claude a plain MCP server that simply offers no
// tools rather than crashing the session.
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listSessionBindings } from "@agents-can-communicate/adapter-sdk";
import { createCoordinationService } from "@agents-can-communicate/core";
import { createId } from "@agents-can-communicate/protocol";
import { openFilesystemStore } from "@agents-can-communicate/storage-filesystem";
import { createGitProbe, discoverWorkspace, platformDataHome, runtimePaths }
  from "@agents-can-communicate/cli";

import { createAccChannel, endpointDir, routeAck, routeReply }
  from "@agents-can-communicate/adapter-claude-code/channel";

const clock = { now: () => new Date().toISOString() };
const ids = { next: kind => createId(kind, randomBytes) };

// The ACC session this Claude process opened, matched by the harness session id
// it exports (CLAUDE_CODE_SESSION_ID), exactly as the CLI's session-owner does.
async function resolveSession({ runtimeDir, service, env }) {
  const bindings = await listSessionBindings({ runtimeDir });
  if (bindings.length === 0) return null;
  const status = await service.collectStatus({});
  const live = new Map(status.participants
    .filter(participant => participant.presence !== "offline")
    .map(participant => [participant.sessionId, participant]));
  const current = bindings.filter(binding => live.has(binding.accSessionId));
  const exported = new Set(Object.values(env).filter(value => typeof value === "string"));
  const matched = current.filter(binding => exported.has(binding.harnessSessionId));
  const chosen = matched.length === 1 ? matched[0] : current.length === 1 ? current[0] : null;
  return chosen === null ? null
    : { sessionId: chosen.accSessionId, generation: chosen.generation, clientPid: chosen.clientPid };
}

async function main() {
  const descriptor = await discoverWorkspace({ cwd: process.cwd(), env: process.env,
    gitProbe: createGitProbe() });
  const paths = runtimePaths({ dataHome: platformDataHome({ platform: process.platform,
    env: process.env }), workspaceId: descriptor.id, workspaceRoots: descriptor.roots });
  const store = await openFilesystemStore({ root: paths.root, clock, ids,
    workspaceId: descriptor.id });
  const service = createCoordinationService({ store, clock, ids });
  const session = await resolveSession({ runtimeDir: paths.root, service, env: process.env });
  if (session === null || !Number.isInteger(session.clientPid)) return null;

  const channel = createAccChannel({
    endpointDir: endpointDir(paths.root),
    clientPid: session.clientPid,
    write: payload => process.stdout.write(`${JSON.stringify(payload)}\n`),
    routeReply: ({ messageId, body }) => routeReply({ service, session, messageId, body }),
    routeAck: ({ messageId }) => routeAck({ service, session, messageId }),
  });
  await channel.listen();

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async chunk => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line !== "") await channel.handleLine(line);
    }
  });
  const shutdown = () => { channel.close(); process.exit(0); };
  process.stdin.on("end", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return channel;
}

const invokedDirectly = typeof process.argv[1] === "string"
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  // Fail open: a Channel that cannot compose is simply absent, never a crash in
  // front of the user's session.
  await main().catch(() => { process.stdin.resume(); });
}
