#!/usr/bin/env node
import { randomBytes } from "node:crypto";

import { createId } from "@agents-can-communicate/protocol";
import { createCoordinationService } from "@agents-can-communicate/core";
import { openFilesystemStore } from "@agents-can-communicate/storage-filesystem";
import { createGitProbe, discoverWorkspace, platformDataHome, runtimePaths }
  from "@agents-can-communicate/cli";
import { serve } from "@agents-can-communicate/mcp-server";

// The composition root is the only place allowed to reach for ambient time and
// randomness. The participant name comes from configuration, never from the
// client: the protocol says clientInfo is self-reported and must not drive
// behaviour, and the session is derived from this configuration alone.
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

await serve({
  input: process.stdin,
  output: process.stdout,
  log: message => process.stderr.write(`acc-mcp: ${message}\n`),
  context: {
    service: createCoordinationService({ store, clock, ids }),
    workspaceId: descriptor.id,
    participantId,
    descriptor,
    runtimeDir: paths.root,
  },
});

// Exiting on stdin EOF is the only portable graceful shutdown in this binding.
process.exitCode = 0;
