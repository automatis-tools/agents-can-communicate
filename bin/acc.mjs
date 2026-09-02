#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createId } from "@agents-can-communicate/protocol";
import { createDeliveryRouter } from "@agents-can-communicate/delivery-router";
import { ALL_ADAPTERS, askConfirmation, main } from "@agents-can-communicate/cli";

const adapters = Object.fromEntries(ALL_ADAPTERS().map(adapter => [adapter.id, adapter]));

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
  createDeliveryRouter: ({ service, clock }) =>
    createDeliveryRouter({ service, adapters, clock }),
  // Asked only by `acc config init`, and only when stdout is a terminal. There
  // was no port here at all, so the question went to the fallback that always
  // answers no: in a real terminal the command printed "not written" and never
  // said why, and `--yes` - the flag documented for runs with nobody to ask -
  // was the only way to write the file.
  confirm: question => askConfirmation(question,
    { input: process.stdin, output: process.stdout }),
  // Asked for only by `acc version`, so a package missing its own manifest
  // fails that one command rather than every command.
  version: async () => JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")).version,
};

process.exitCode = await main(process.argv.slice(2), runtime);
