#!/usr/bin/env node
import { randomBytes } from "node:crypto";

import { EXIT, createId } from "@agents-can-communicate/protocol";
import { createCoordinationService } from "@agents-can-communicate/core";
import { createDeliveryRouter } from "@agents-can-communicate/delivery-router";
import { openFilesystemStore } from "@agents-can-communicate/storage-filesystem";
import { ALL_ADAPTERS, createGitProbe, discoverWorkspace, platformDataHome, runtimePaths }
  from "@agents-can-communicate/cli";
import { serve } from "@agents-can-communicate/mcp-server";

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

const descriptor = await discoverWorkspace({
  cwd: process.env.ACC_MCP_WORKSPACE ?? process.cwd(),
  env: process.env,
  gitProbe: createGitProbe(),
});
const paths = runtimePaths({
  dataHome: platformDataHome({ platform: process.platform, env: process.env }),
  workspaceId: descriptor.id,
  workspaceRoots: descriptor.roots,
});
const store = await openFilesystemStore({ root: paths.root, clock, ids,
  workspaceId: descriptor.id });
const service = createCoordinationService({ store, clock, ids });
const adapters = Object.fromEntries(ALL_ADAPTERS().map(adapter => [adapter.id, adapter]));

await serve({
  input: process.stdin,
  output: process.stdout,
  log: message => process.stderr.write(`acc-mcp: ${message}\n`),
  context: {
    service,
    deliveryRouter: createDeliveryRouter({ service, adapters, clock }),
    workspaceId: descriptor.id,
    participantId,
    descriptor,
    runtimeDir: paths.root,
  },
});

// Exiting on stdin EOF is the only portable graceful shutdown in this binding.
process.exitCode = 0;
