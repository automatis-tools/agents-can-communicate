#!/usr/bin/env node
// The relay the agent starts: `start` in its tool shell, `run` detached from it.
// Fails open everywhere - `start` prints one line and exits 0; `run` answers its
// ready line and exits quietly when anything it needs is missing.
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";
import path from "node:path";

import { createAgentApi } from "@agents-can-communicate/adapter-antigravity/agentapi";
import { createRelay } from "@agents-can-communicate/adapter-antigravity/relay";
import { listRegistrations, newRelayId, relayDir } from "@agents-can-communicate/adapter-antigravity/relay-endpoint";
import { findConversation, startRelay } from "@agents-can-communicate/adapter-antigravity/relay-start";
import { loadSessionBinding } from "@agents-can-communicate/adapter-sdk";
import { platformDataHome } from "@agents-can-communicate/cli";
import { createCoordinationService } from "@agents-can-communicate/core";
import { resolveClientPid } from "@agents-can-communicate/hook-runner/client-pid";
import { readProcessTable } from "@agents-can-communicate/hook-runner/process-table";
import { readInstalledLivePolicy } from "@agents-can-communicate/installer";
import { createId } from "@agents-can-communicate/protocol";
import { openFilesystemStore } from "@agents-can-communicate/storage-filesystem";

import { activateAntigravityRelay } from "./antigravity-relay-binding.mjs";

const clock = { now: () => new Date().toISOString() };
const ids = { next: kind => createId(kind, randomBytes) };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const READY_MS = 10_000;

const argvOf = pid => new Promise(resolve => execFile("ps", ["-o", "args=", "-p", String(pid)],
  { timeout: 1_000 }, (_error, out) => resolve(String(out ?? "").trim().split(/\s+/).filter(Boolean))));

function spawnRun({ env, payload }) {
  return new Promise(resolve => {
    // Through the launcher that ran `start`, never this module directly: an
    // entry module does not run itself, and under the managed runtime the
    // launcher takes the lease that keeps this generation installed for as
    // long as the relay lives.
    const child = spawn(process.execPath, [process.argv[1], "run"],
      { env, detached: true, stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.unref();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "no ready line within 10 seconds" }), READY_MS);
    child.stdout.on("data", chunk => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try { finish(JSON.parse(buffer.slice(0, newline))); }
      catch { finish({ ok: false, reason: "unreadable ready line" }); }
    });
    child.on("error", () => finish({ ok: false, reason: "could not start" }));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function start() {
  const dataHome = platformDataHome({ platform: process.platform, env: process.env });
  const line = await startRelay({ env: process.env, pid: process.pid,
    readTable: () => readProcessTable(), argvOf,
    resolveAgyPid: (table, from) => resolveClientPid({ table, from, command: "agy" }),
    readPolicy: () => readInstalledLivePolicy({ dataHome, adapterId: "antigravity" }),
    findConversation: ({ conversationId, agyPid }) => findConversation({ dataHome, conversationId, agyPid }),
    liveRelayFor: async ({ runtimeDir, conversationId }) => (await listRegistrations({ runtimeDir }))
      .some(record => record.conversationId === conversationId && alive(record.relayPid)),
    spawnRun });
  process.stdout.write(`${line}\n`);
}

async function readPayload() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return JSON.parse(text);
}

// Event names, message ids and closed reason codes only: never a body, the
// token, the address or the nonce.
const logger = file => entry => appendFile(file, `${JSON.stringify({ at: clock.now(), ...entry })}\n`,
  { mode: 0o600 }).catch(() => {});

async function run() {
  const ready = result => process.stdout.write(`${JSON.stringify(result)}\n`);
  const payload = await readPayload();
  const { runtimeDir, conversationId, agyPid } = payload;
  const dataHome = platformDataHome({ platform: process.platform, env: process.env });
  const store = await openFilesystemStore({ root: runtimeDir, clock, ids, workspaceId: payload.workspaceId });
  const service = createCoordinationService({ store, clock, ids });
  const current = () => loadSessionBinding({ runtimeDir, harnessSessionId: conversationId });
  const bound = await current();
  if (bound === null || bound.clientPid !== agyPid) {
    ready({ ok: false, reason: "no ACC session for this conversation" });
    return;
  }
  const endpointId = newRelayId();
  const relay = createRelay({ runtimeDir, conversationId, agyPid, isAlive: alive, endpointId,
    clientVersion: bound.clientVersion,
    observe: logger(path.join(relayDir(runtimeDir), `${endpointId}.log`)),
    api: createAgentApi({ endpoint: payload, baseEnv: process.env }),
    // The conversation can reopen under a new ACC generation while this relay
    // keeps serving it, so renew whichever binding is current, never a copy.
    refreshBinding: async leaseUntil => {
      const now = await current();
      if (now?.clientPid !== agyPid) return;
      await service.refreshDeliveryBinding({ sessionId: now.accSessionId, generation: now.generation,
        leaseUntil });
    },
    onExit: async () => {
      const now = await current().catch(() => null);
      if (now !== null) {
        await service.clearDeliveryBinding({ sessionId: now.accSessionId, generation: now.generation,
          opaqueEndpointRef: endpointId }).catch(() => {});
      }
      process.exit(0);
    } });
  await relay.listen();
  process.on("SIGTERM", () => { relay.close("terminated"); });
  const activation = await activateAntigravityRelay({ session: { sessionId: bound.accSessionId,
    generation: bound.generation, clientPid: bound.clientPid, harnessSessionId: conversationId },
  service, runtimeDir, dataHome }).catch(() => null);
  if (activation?.state === "active") {
    ready({ ok: true });
    return;
  }
  ready({ ok: false, reason: activation?.reasonCode ?? "binding was not published" });
  await relay.close("not_activated");
}

export async function main() {
  const [command] = process.argv.slice(2);
  if (command === "run") await run().catch(() => process.exit(0));
  else await start().catch(() => process.stdout.write(
    "ACC: live delivery did not start; peers still reach this conversation at its next turn.\n"));
}
