#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

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
  // Asked for only by `acc version`, so a package missing its own manifest
  // fails that one command rather than every command.
  version: async () => JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")).version,
};

process.exitCode = await main(process.argv.slice(2), runtime);
