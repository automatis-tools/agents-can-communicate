#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { watch as fsWatch } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { describeAttachment } from "./lib/attachments.mjs";
import { claimScope, extendClaims, forceReleaseStaleScope, releaseOwnedClaims, releaseScope }
  from "./lib/claims.mjs";
import { CommsError, EXIT } from "./lib/errors.mjs";
import { createHandoff } from "./lib/handoff.mjs";
import { closeAgent, initBus, registerAgent } from "./lib/identity.mjs";
import { renderPrompt } from "./lib/prompt.mjs";
import { ackMessage, broadcastMessage, listInbox, markSeen, replyToMessage, sendMessage }
  from "./lib/messages.mjs";
import { createBusPaths, resolveBusDir } from "./lib/paths.mjs";
import { startWatcher, waitForMessage } from "./lib/presence.mjs";
import { parseArgs } from "./lib/args.mjs";
import { listJsonFiles, readJsonStrict } from "./lib/atomic-json.mjs";
import { validateRegistry } from "./lib/schema.mjs";
import { withSignalStop } from "./lib/signal-stop.mjs";
import { collectStatus, enforcementExit, runDoctor } from "./lib/status.mjs";

const execFileAsync = promisify(execFile);

function defaultPidIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

function fallbackWatch(directory, listener) {
  try {
    const watcher = fsWatch(directory, listener);
    watcher.on("error", () => {});
    return { close: () => watcher.close(), once: (event, handler) => {
      if (event !== "error") watcher.once(event, handler);
    } };
  }
  catch (error) {
    if (!["EMFILE", "ENOSPC"].includes(error.code)) throw error;
    return { close() {}, once() {} };
  }
}

async function defaultGitQuery(cwd, args) {
  return (await execFileAsync("git", args, { cwd })).stdout;
}

async function write(stream, text) {
  await new Promise((resolve, reject) => stream.write(text, error => error ? reject(error) : resolve()));
}

async function readStdin(stdin) {
  if (typeof stdin === "string") return stdin;
  let result = "";
  for await (const chunk of stdin) result += chunk;
  return result;
}

function seconds(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new CommsError(`${name} must be a non-negative number of seconds`, EXIT.DATA);
  }
  return Math.round(number * 1_000);
}

async function jsonFile(cwd, filePath, name) {
  try { return JSON.parse(await readFile(path.resolve(cwd, filePath), "utf8")); }
  catch (error) { throw new CommsError(`cannot read ${name}`, EXIT.DATA, { cause: error.message }); }
}

async function attachments(context, options) {
  const regular = (options.attachment ?? []).map(file => ({ path: file, ephemeral: false }));
  const ephemeral = (options.ephemeralAttachment ?? []).map(file => ({ path: file, ephemeral: true }));
  return Promise.all([...regular, ...ephemeral].map(item => describeAttachment(context, item)));
}

async function openAgentIds(context) {
  const records = await Promise.all((await listJsonFiles(context.paths.registry,
    { root: context.paths.root })).map(file =>
    readJsonStrict(file, validateRegistry, context.paths.root)));
  return records.filter(record => record.status === "open").map(record => record.agent_id).sort();
}

async function requireInitialized(context) {
  try { await access(context.paths.protocol); }
  catch (error) {
    if (error.code === "ENOENT") throw new CommsError("agent bus protocol is not initialized; run init", EXIT.DATA);
    throw error;
  }
}

async function emit(context, value, json, human) {
  await write(context.stdout, json ? `${JSON.stringify(value)}\n` : `${human}\n`);
}

async function runInit(context, options) {
  const value = await initBus(context);
  await emit(context, value, options.json, "agent bus initialized");
  return EXIT.OK;
}

async function runPrompt(context, options) {
  const ownership = options.ownership?.join(" --ownership ") ?? "";
  const value = await renderPrompt({
    templatePath: path.join(context.repoRoot, "docs/AGENT_COMMS_PROMPT.md"),
    agentId: options.id,
    role: options.role,
    task: options.task,
    ownership,
  });
  await write(context.stdout, value);
  return EXIT.OK;
}

async function runRegister(context, options) {
  await requireInitialized(context);
  const value = await registerAgent(context, { agentId: options.id, role: options.role, task: options.task,
    ownership: options.ownership ?? [], client: options.client, resume: options.resume === true,
    worktree: context.cwd });
  await emit(context, value, options.json, `registered ${value.agent_id}`);
  return EXIT.OK;
}

async function runClose(context, options) {
  await requireInitialized(context);
  const value = await closeAgent(context, options.id);
  await emit(context, value, options.json, `closed ${value.agent_id}`);
  return EXIT.OK;
}

async function messageInput(context, options, extra = {}) {
  const input = { ...extra, from: options.from, to: options.to, type: options.type, severity: options.severity,
    subject: options.subject, body: options.body, bodyFile: options.bodyFile && path.resolve(context.cwd, options.bodyFile),
    task: options.task, requiresAck: options.requiresAck === true };
  if (options.body === undefined && options.bodyFile === undefined) input.stdin = await readStdin(context.stdin);
  return input;
}

async function runSend(context, options) {
  await requireInitialized(context);
  const input = await messageInput(context, options);
  input.attachments = await attachments(context, options);
  const value = await sendMessage(context, input);
  await emit(context, value, options.json, `sent ${value.id}`);
  return EXIT.OK;
}

async function runBroadcast(context, options) {
  await requireInitialized(context);
  const input = await messageInput(context, options);
  input.attachments = await attachments(context, options);
  const value = await broadcastMessage(context, input);
  await emit(context, value, options.json, `broadcast to ${value.length} agents`);
  return EXIT.OK;
}

async function runInbox(context, options) {
  await requireInitialized(context);
  const value = await listInbox(context, { agentId: options.id, types: options.type, severities: options.severity });
  await emit(context, value, options.json, value.map(item => `${item.state}: ${item.message.subject}`).join("\n") || "inbox empty");
  for (const item of value) await markSeen(context, item.message, options.id);
  return EXIT.OK;
}

async function runAck(context, options) {
  await requireInitialized(context);
  const value = await ackMessage(context, { agentId: options.id, messageId: options.message });
  await emit(context, value, options.json, `acknowledged ${value.message_id}`);
  return EXIT.OK;
}

async function runReply(context, options) {
  await requireInitialized(context);
  const input = await messageInput(context, options, { messageId: options.message });
  input.attachments = await attachments(context, options);
  const value = await replyToMessage(context, input);
  await emit(context, value, options.json, `replied ${value.id}`);
  return EXIT.OK;
}

async function runWatch(context, options) {
  await requireInitialized(context);
  const watcher = await startWatcher(context, { agentId: options.id, heartbeatMs: options.heartbeat && seconds(options.heartbeat, "heartbeat"),
    scanIntervalMs: options.scanInterval && seconds(options.scanInterval, "scan interval") });
  await context.beforeWatcherPublish?.(watcher);
  context.setActiveWatcher?.(watcher);
  try { await watcher.done; return EXIT.OK; }
  finally { context.setActiveWatcher?.(null); }
}

async function runWait(context, options) {
  await requireInitialized(context);
  const value = await waitForMessage(context, { agentId: options.id,
    timeoutMs: options.timeout === undefined ? undefined : seconds(options.timeout, "timeout"),
    scanIntervalMs: options.scanInterval && seconds(options.scanInterval, "scan interval") });
  if (value === null) return EXIT.TIMEOUT;
  await emit(context, value, options.json, `message: ${value.subject}`);
  await markSeen(context, value, options.id);
  return EXIT.OK;
}

async function runClaim(context, options) {
  await requireInitialized(context);
  const value = await claimScope(context, { agentId: options.id, scope: options.scope, reason: options.reason,
    leaseSeconds: options.lease === undefined ? undefined : Number(options.lease) });
  await emit(context, value, options.json, `claimed ${value.scope}`);
  return EXIT.OK;
}

async function runRelease(context, options) {
  await requireInitialized(context);
  const value = options.forceStale ? await forceReleaseStaleScope(context, { agentId: options.id,
    owner: options.owner, scope: options.scope }) : await releaseScope(context, { agentId: options.id, scope: options.scope });
  await emit(context, value, options.json, `released ${value.scope}`);
  return EXIT.OK;
}

async function runHandoff(context, options) {
  await requireInitialized(context);
  const [verification, contracts, limitations] = await Promise.all([
    jsonFile(context.cwd, options.verificationFile, "verification file"),
    jsonFile(context.cwd, options.contractsFile, "contracts file"),
    jsonFile(context.cwd, options.limitationsFile, "limitations file"),
  ]);
  const artifacts = await Promise.all((options.artifact ?? []).map(file => describeAttachment(context, {
    path: file, ephemeral: false, ...(options.commit === undefined ? {} : { commit: options.commit }) })));
  const value = await createHandoff(context, { from: options.id, to: options.to, task: options.task,
    result: options.result, branch: options.branch, commit: options.commit ?? null, base: options.base,
    changedPaths: options.changed ?? [], verification, contracts, followUp: options.followUp ?? [], artifacts, limitations,
    uncommitted: options.uncommitted === true });
  await emit(context, value, options.json, `handoff ${value.record.id}`);
  return EXIT.OK;
}

async function runStatus(context, options) {
  await requireInitialized(context);
  const value = await collectStatus(context);
  await emit(context, value, options.json, `agents: ${value.counts.live_agents} live; pending: ${value.counts.required_unacked}`);
  return enforcementExit(value, options);
}

async function runDoctorCommand(context, options) {
  await requireInitialized(context);
  const value = await runDoctor(context, { repair: options.repair === true,
    requireLive: (options.requireLive ?? []).flatMap(value => value.split(",")).filter(Boolean) });
  await emit(context, value, options.json, value.ok ? "doctor: healthy" : `doctor: ${value.issues.length} issue(s)`);
  if (value.ok) return EXIT.OK;
  if (value.issues.some(item => item.code.includes("CORRUPT") || item.code === "PROTOCOL_MISSING")) return EXIT.DATA;
  if (value.issues.some(item => item.code.startsWith("REQUIRED_") || item.code === "ACKED_MESSAGE_NOT_ARCHIVED")) return EXIT.REQUIRED;
  return EXIT.CONFLICT;
}

const COMMANDS = Object.freeze({ init: runInit, prompt: runPrompt, register: runRegister, close: runClose, send: runSend,
  broadcast: runBroadcast, inbox: runInbox, ack: runAck, reply: runReply, watch: runWatch,
  wait: runWait, claim: runClaim, release: runRelease, handoff: runHandoff, status: runStatus,
  doctor: runDoctorCommand });

export async function main(argv, runtime = {}) {
  const parsed = parseArgs(argv);
  const cwd = runtime.cwd ?? process.cwd();
  const runGit = runtime.gitQuery ?? defaultGitQuery;
  const busDir = await resolveBusDir({ cwd, env: runtime.env ?? process.env,
    runGit: directory => runGit(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) });
  const context = { cwd, paths: createBusPaths(busDir), repoRoot: cwd, stdout: runtime.stdout ?? process.stdout,
    stderr: runtime.stderr ?? process.stderr, stdin: runtime.stdin ?? process.stdin, now: runtime.time ?? (() => new Date()),
    pid: runtime.pid ?? process.pid, pidIsAlive: runtime.pidIsAlive ?? defaultPidIsAlive,
    randomUUID: runtime.uuid ?? randomUUID, scheduler: runtime.scheduler, watchDirectory: runtime.watchDirectory ?? fallbackWatch,
    setActiveWatcher: runtime.setActiveWatcher, beforeWatcherPublish: runtime.beforeWatcherPublish,
    gitState: async directory => ({ branch: (await runGit(directory, ["branch", "--show-current"])).trim(),
      head: (await runGit(directory, ["rev-parse", "HEAD"])).trim() }),
    releaseOwnedClaims: agentId => releaseOwnedClaims(context, agentId),
    extendOwnedClaims: agentId => extendClaims(context, agentId), listActiveAgentIds: () => openAgentIds(context),
    output: async event => { await write(context.stdout, `${JSON.stringify(event)}\n`); await write(context.stderr, "\u0007"); } };
  return COMMANDS[parsed.command](context, parsed.options);
}

export function runWithSignals(argv, runtime = {}, signals = process) {
  return withSignalStop(setActiveWatcher => main(argv, { ...runtime, setActiveWatcher }), signals);
}

async function invoke() {
  try { process.exitCode = await runWithSignals(process.argv.slice(2)); }
  catch (error) {
    process.exitCode = error instanceof CommsError ? error.exitCode : 1;
    await write(process.stderr, `${error instanceof CommsError ? error.message : error.stack}\n`);
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) void invoke();
