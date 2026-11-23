#!/usr/bin/env node
import { randomBytes } from "node:crypto";

import { EXIT, createId } from "@agents-can-communicate/protocol";
import { createCoordinationService } from "@agents-can-communicate/core";
import { readInstalledLivePolicy } from "@agents-can-communicate/installer/live-policy";
import { createDeliveryRouter } from "@agents-can-communicate/delivery-router";
import { registerDiscoveredSessions } from "@agents-can-communicate/hook-runner";
import { openFilesystemStore } from "@agents-can-communicate/storage-filesystem";
import { loadAdapter, loadAdapters } from "@agents-can-communicate/cli/adapters";
import { createGitProbe } from "@agents-can-communicate/cli/git-probe";
import { platformDataHome, runtimePaths } from "@agents-can-communicate/cli/runtime-paths";
import { discoverWorkspace } from "@agents-can-communicate/cli/workspace-discovery";
import { serve } from "@agents-can-communicate/mcp-server";

export async function main({ managerRoot = null, packageRoot } = {}) {
// The composition root is the only place allowed to reach for ambient time and
// randomness. The participant name comes from configuration, never from the
// client: the protocol says clientInfo is self-reported and must not drive
// behaviour, and the session is derived from this configuration alone.
// Nothing is read from the command line, so nothing may be passed on it. It
// used to accept and ignore anything: writing `acc-mcp --cwd <project>` - the
// habit `acc` teaches - started a server rooted wherever the client happened to
// launch it, alone in a workspace nobody else was in, with no warning at all.
if (process.argv.length > 2) {
  process.stderr.write("acc-mcp takes no arguments. It is configured by environment:\n"
    + "  ACC_MCP_PARTICIPANT   who this server takes part as (default: mcp)\n"
    + "  ACC_MCP_WORKSPACE     the project it joins (default: the working directory)\n"
    + `refusing: ${process.argv.slice(2).join(" ")}\n`);
  process.exit(EXIT.USAGE);
}

const participantId = process.env.ACC_MCP_PARTICIPANT ?? "mcp";
const clock = { now: () => new Date().toISOString() };
const ids = { next: kind => createId(kind, randomBytes) };

const log = message => process.stderr.write(`acc-mcp: ${message}\n`);
const dataHome = platformDataHome({ platform: process.platform, env: process.env });
// A client that only catalogues the server - an MCP directory, or a host that
// starts it from the home directory - still gets its tools. Only a tool call
// needs a workspace, and it says why there is none (#149). Without this, a
// directory that holds ACC's own state ended the process before `initialize`.
let workspace;
try {
  const descriptor = await discoverWorkspace({
    cwd: process.env.ACC_MCP_WORKSPACE ?? process.cwd(),
    env: process.env,
    gitProbe: createGitProbe(),
  });
  const paths = runtimePaths({
    dataHome,
    workspaceId: descriptor.id,
    workspaceRoots: descriptor.roots,
  });
  const store = await openFilesystemStore({ root: paths.root, clock, ids,
    workspaceId: descriptor.id });
  workspace = { descriptor, paths, service: createCoordinationService({ store, clock, ids }) };
} catch (error) {
  log(`no workspace: ${error.message}`);
  await serve({ input: process.stdin, output: process.stdout, log,
    context: { unavailable: `no workspace: ${error.message}` } });
  process.exitCode = 0;
  return;
}
const { descriptor, paths, service } = workspace;

await serve({
  input: process.stdin,
  output: process.stdout,
  log,
  context: {
    service,
    // Each recipient's adapter loads with the first message routed to it (#270).
    deliveryRouter: createDeliveryRouter({ service, loadAdapter, clock,
      readLivePolicy: ({ adapter }) => readInstalledLivePolicy({ dataHome,
        adapterId: adapter.id }) }),
    workspaceId: descriptor.id,
    participantId,
    descriptor,
    runtimeDir: paths.root,
    registerNativeSessions: () => registerDiscoveredSessions({ loadAdapters,
      workspaceId: descriptor.id, dataHome, env: process.env }),
  },
});

// Exiting on stdin EOF is the only portable graceful shutdown in this binding.
process.exitCode = 0;

}
