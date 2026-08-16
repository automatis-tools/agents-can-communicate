#!/usr/bin/env node
import { randomBytes } from "node:crypto";

import { createId } from "@agents-can-communicate/protocol";
import { main } from "@agents-can-communicate/cli";

// The composition root is the only place allowed to reach for ambient time and
// randomness; everything below it receives them as ports.
const runtime = {
  cwd: process.cwd(),
  env: process.env,
  platform: process.platform,
  stdout: process.stdout,
  stderr: process.stderr,
  clock: { now: () => new Date().toISOString() },
  ids: { next: kind => createId(kind, randomBytes) },
};

process.exitCode = await main(process.argv.slice(2), runtime);
