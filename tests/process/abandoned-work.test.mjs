import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { loadSessionBinding } from "@agents-can-communicate/adapter-sdk";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const acc = path.join(repo, "bin", "acc.mjs");
const hook = path.join(repo, "bin", "acc-hook.mjs");

/** A direct question remains visible when its recipient leaves. */
async function workspace(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-abandon-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = path.join(base, "game");
  await mkdir(project, { recursive: true });
  const env = { ...process.env, ACC_DATA_HOME: path.join(base, "data"),
    GIT_DIR: "", GIT_WORK_TREE: "" };
  return { project, env };
}

const named = (env, participant) => ({ ...env, ACC_PARTICIPANT: participant });

async function hookEvent({ env, project }, adapter, clientSessionId, participant,
  kind, payload) {
  const child = run(process.execPath, [hook, adapter, kind],
    { env: named(env, participant) });
  child.child.stdin.end(JSON.stringify({ session_id: clientSessionId, cwd: project,
    ...payload }));
  const { stdout } = await child;
  return stdout;
}

async function attach(place, adapter, clientSessionId, participant) {
  await hookEvent(place, adapter, clientSessionId, participant, "sessionStart",
    { hook_event_name: "SessionStart", source: "startup" });
  const { stdout } = await run(process.execPath,
    [acc, "doctor", "--cwd", place.project, "--json"], { env: place.env });
  return loadSessionBinding({ runtimeDir: JSON.parse(stdout).data.runtimeRoot,
    harnessSessionId: clientSessionId });
}

async function turn(place, adapter, clientSessionId, participant) {
  const stdout = await hookEvent(place, adapter, clientSessionId, participant,
    "userPromptSubmit", { hook_event_name: "UserPromptSubmit", prompt: "go on" });
  if (stdout.trim() === "") return "";
  if (!stdout.trimStart().startsWith("{")) return stdout;
  return JSON.parse(stdout).hookSpecificOutput?.additionalContext ?? "";
}

const cli = ({ env, project }, ...argv) =>
  run(process.execPath, [acc, ...argv, "--cwd", project], { env });

test("a direct message can be answered without a written reply", async t => {
  const place = await workspace(t);
  const asker = await attach(place, "codex", "gfx", "graphics");
  const doer = await attach(place, "kimi", "phys", "physics");
  const { stdout } = await cli(place, "message", "--session", asker.accSessionId,
    "--generation", asker.generation, "--to", "physics", "--type", "question",
    "--subject", "scale", "--body", "Is the tank scale settled?", "--requires-ack");
  const messageId = stdout.trim().replace(/^sent /, "");

  assert.match(await turn(place, "kimi", "phys", "physics"),
    /\[direct_request\] message_\S+ scale/);
  await cli(place, "ack", "--session", doer.accSessionId, "--generation", doer.generation,
    "--message", messageId);

  const after = await turn(place, "kimi", "phys", "physics");
  assert.equal(after.includes("[direct_request]"), false, after);
});

test("a direct question outlives the agent it was put to", async t => {
  const place = await workspace(t);
  const asker = await attach(place, "codex", "gfx", "graphics");
  await attach(place, "kimi", "phys", "physics");
  await cli(place, "message", "--session", asker.accSessionId,
    "--generation", asker.generation, "--to", "physics",
    "--subject", "which way should the hull clamp?",
    "--body", "It is blocking my rendering work.", "--requires-ack");

  const waiting = await turn(place, "codex", "gfx", "graphics");
  assert.equal(waiting.includes("request_stalled"), false, waiting);

  await hookEvent(place, "kimi", "phys", "physics", "sessionEnd",
    { hook_event_name: "SessionEnd", reason: "exit" });

  const alone = await turn(place, "codex", "gfx", "graphics");
  assert.match(alone, /\[request_stalled\] message_\S+ which way should the hull clamp\?/,
    `the asker was left waiting on a question nobody can answer:\n${alone}`);
  assert.match(alone, /physics is not here to answer/);
});

test("an answered question stops being reported, even once its author leaves", async t => {
  const place = await workspace(t);
  const asker = await attach(place, "codex", "gfx", "graphics");
  const doer = await attach(place, "kimi", "phys", "physics");
  await cli(place, "message", "--session", asker.accSessionId,
    "--generation", asker.generation, "--to", "physics",
    "--subject", "which way should the hull clamp?", "--body", "Blocking me.",
    "--requires-ack");
  const [pending] = JSON.parse((await cli(place, "sync", "--session", doer.accSessionId,
    "--scope", "full", "--json")).stdout).data.snapshot.messages;

  await cli(place, "ack", "--session", doer.accSessionId,
    "--generation", doer.generation, "--message", pending.messageId);
  await hookEvent(place, "kimi", "phys", "physics", "sessionEnd",
    { hook_event_name: "SessionEnd", reason: "exit" });

  const after = await turn(place, "codex", "gfx", "graphics");
  assert.equal(after.includes("request_stalled"), false, after);
});

test("only the agent who asked is told", async t => {
  const place = await workspace(t);
  const asker = await attach(place, "codex", "gfx", "graphics");
  await attach(place, "kimi", "phys", "physics");
  const bystander = await attach(place, "claude_code", "snd", "sound");
  await cli(place, "message", "--session", asker.accSessionId,
    "--generation", asker.generation, "--to", "physics",
    "--subject", "which way should the hull clamp?", "--body", "Blocking me.",
    "--requires-ack");
  await hookEvent(place, "kimi", "phys", "physics", "sessionEnd",
    { hook_event_name: "SessionEnd", reason: "exit" });

  const seen = await turn(place, "claude_code", "snd", "sound");
  assert.equal(seen.includes("request_stalled"), false, seen);
  assert.equal(typeof bystander.accSessionId, "string");
});
