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

import { createAccChannel, createInertChannel, endpointDir, routeAck, routeReply }
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

// How long the Channel will wait for the hook to publish this session's
// binding. Claude spawns this child while SessionStart is still running - both
// landed in the same second on a real 2.1.259 launch - and a single lookup
// loses that race often enough to make native delivery activate or not per
// launch. Bounded, because a session with no ACC binding must still be answered.
const BINDING_WAIT_MS = 5_000;
const BINDING_POLL_MS = 100;

/**
 * The session binding, once it exists - or null when the wait runs out.
 *
 * A binding with no `clientPid` names no process, and the Channel binds an
 * exact one, so it does not count as resolved: the hook writes the identity
 * first and the certified facts after, and reading in between must keep waiting
 * rather than settle for the half-written answer.
 */
export async function resolveWithin({ resolve, deadline, intervalMs = BINDING_POLL_MS,
  now = () => Date.now(), sleep = ms => new Promise(resolve_ => setTimeout(resolve_, ms)) }) {
  for (;;) {
    const session = await resolve();
    if (session !== null && Number.isInteger(session?.clientPid)) return session;
    if (now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

async function main() {
  const descriptor = await discoverWorkspace({ cwd: process.cwd(), env: process.env,
    gitProbe: createGitProbe() });
  const paths = runtimePaths({ dataHome: platformDataHome({ platform: process.platform,
    env: process.env }), workspaceId: descriptor.id, workspaceRoots: descriptor.roots });
  const store = await openFilesystemStore({ root: paths.root, clock, ids,
    workspaceId: descriptor.id });
  const service = createCoordinationService({ store, clock, ids });
  const write = payload => process.stdout.write(`${JSON.stringify(payload)}\n`);
  const session = await resolveWithin({
    resolve: () => resolveSession({ runtimeDir: paths.root, service, env: process.env }),
    deadline: Date.now() + BINDING_WAIT_MS });
  // No binding to serve - but Claude is already speaking MCP to this child, and
  // returning here left the event loop empty: the process exited in 75ms
  // without answering `initialize`, and Claude reported the server as failed to
  // connect on every session that enables the plugin without ACC's shim.
  if (session === null || !Number.isInteger(session.clientPid)) {
    const inert = createInertChannel({ write });
    pump(inert.handleLine, () => process.exit(0));
    return inert;
  }

  const channel = createAccChannel({
    endpointDir: endpointDir(paths.root),
    clientPid: session.clientPid,
    write,
    routeReply: ({ messageId, body }) => routeReply({ service, session, messageId, body }),
    routeAck: ({ messageId }) => routeAck({ service, session, messageId }),
  });
  await channel.listen();
  pump(channel.handleLine, () => { channel.close(); process.exit(0); });
  return channel;
}

/** One line-delimited JSON pump, for the bound server and the unbound one alike. */
function pump(handleLine, shutdown) {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async chunk => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line !== "") await handleLine(line);
    }
  });
  process.stdin.on("end", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  // Keeps the child answerable for as long as Claude holds the transport open.
  process.stdin.resume();
}

const invokedDirectly = typeof process.argv[1] === "string"
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  // Fail open: a Channel that cannot compose is simply absent, never a crash in
  // front of the user's session.
  await main().catch(() => { process.stdin.resume(); });
}
