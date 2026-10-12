#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createId } from "@agents-can-communicate/protocol";
import { loadAdapter, loadAdapters } from "@agents-can-communicate/cli/adapters";
import { askConfirmation } from "@agents-can-communicate/cli/confirm";
import { main as runCli } from "@agents-can-communicate/cli/main";

// A command loads what it uses: `acc version` no client adapter, store or
// router, and a message only its recipients' adapters (#270).
const lazyRouter = ({ service, clock, dataHome }) => {
  let router;
  return { offer: async message => {
    router ??= Promise.all([import("@agents-can-communicate/delivery-router"),
      import("@agents-can-communicate/installer/live-policy")])
      .then(([{ createDeliveryRouter }, { readInstalledLivePolicy }]) =>
        createDeliveryRouter({ service, loadAdapter, clock,
          readLivePolicy: ({ adapter }) => readInstalledLivePolicy({ dataHome,
            adapterId: adapter.id }) }));
    return (await router).offer(message);
  } };
};

export async function main({ managerRoot = null, packageRoot, managementOnly = false } = {}) {

// The composition root is the only place allowed to reach for ambient time and
// randomness; everything below it receives them as ports.
const runtime = {
  cwd: process.cwd(),
  managerRoot,
  managementOnly,
  packageRoot,
  env: process.env,
  platform: process.platform,
  stdout: process.stdout,
  stderr: process.stderr,
  clock: { now: () => new Date().toISOString() },
  ids: { next: kind => createId(kind, randomBytes) },
  createDeliveryRouter: lazyRouter,
  // Chats a client holds before their first turn, registered before status
  // is read so a peer can address them (#167).
  registerNativeSessions: async ({ workspaceId, dataHome }) =>
    (await import("@agents-can-communicate/hook-runner")).registerDiscoveredSessions({
      loadAdapters, workspaceId, dataHome, env: process.env }),
  // Asked only by `acc config init`, and only when stdout is a terminal. There
  // was no port here at all, so the question went to the fallback that always
  // answers no: in a real terminal the command printed "not written" and never
  // said why, and `--yes` - the flag documented for runs with nobody to ask -
  // was the only way to write the file.
  confirm: (question, io = { input: process.stdin, output: process.stdout }) =>
    askConfirmation(question, io),
  // The two streams and the fact that a person is at both ends, for the
  // per-client native delivery question `acc install` asks only interactively.
  input: process.stdin,
  output: process.stdout,
  isInteractive: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
  // Asked for only by `acc version`, so a package missing its own manifest
  // fails that one command rather than every command.
  version: async () => JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8")).version,
};

process.exitCode = await runCli(process.argv.slice(2), runtime);

}
