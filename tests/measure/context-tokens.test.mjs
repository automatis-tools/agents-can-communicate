import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { parseClaude, parseCodex, parseGemini, parseKimi } from "../../scripts/measure/context-clients.mjs";
import { renderSurfaces, skillListing } from "../../scripts/measure/context-surfaces.mjs";
import { median, renderTables, withData } from "../../scripts/measure/context-tokens.mjs";

const run = promisify(execFile);

// Each parser reads the shape its client printed on 2026-11-23.
test("Claude Code: the first request of the turn, with its cache reads and writes", () => {
  const stdout = JSON.stringify({ result: "OK", num_turns: 1,
    usage: { iterations: [{ input_tokens: 2, cache_read_input_tokens: 649, cache_creation_input_tokens: 2287 },
      { input_tokens: 9, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 }] },
    modelUsage: { "claude-opus-5-5": { contextWindow: 1_000_000 } } });
  assert.deepEqual(parseClaude(stdout), { inputTokens: 2938, requests: 2, toolCalls: 0,
    model: "claude-opus-5-5", contextWindow: 1_000_000, reply: "OK" });
});

test("Codex: the first request of the newest turn in the rollout, not the session total", () => {
  const stdout = [
    { type: "item.completed", item: { type: "error", message: "bypass-hook-trust is enabled" } },
    { type: "item.completed", item: { type: "agent_message", text: "OK" } },
    { type: "turn.completed", usage: { input_tokens: 30420 } },
  ].map(line => JSON.stringify(line)).join("\n");
  const usage = input => ({ type: "event_msg", payload: { type: "token_count",
    info: { last_token_usage: { input_tokens: input }, model_context_window: 475_000 } } });
  const rollout = [{ type: "turn_context", payload: { model: "gpt-6.2-sol" } }, usage(15202),
    { type: "turn_context", payload: { model: "gpt-6.2-sol" } }, usage(15218), usage(16100)]
    .map(line => JSON.stringify(line)).join("\n");
  assert.deepEqual(parseCodex(stdout, rollout), { inputTokens: 15218, requests: 2, toolCalls: 0,
    model: "gpt-6.2-sol", contextWindow: 475_000, reply: "OK" });
  assert.throws(() => parseCodex(stdout, ""), /no request/);
});

test("Gemini CLI: the main model only, and no count when it took more than one request", () => {
  const stats = (requests, errors) => ({ "gemini-3.1-flash-lite": { roles: { utility_router: {} },
    api: { totalRequests: 4, totalErrors: 3 }, tokens: { prompt: 975 } },
  "gemini-3.6-flash": { roles: { main: {} }, api: { totalRequests: requests, totalErrors: errors },
    tokens: { prompt: 9356 } } });
  const print = models => `Warning: Basic terminal detected\n${JSON.stringify({ response: "OK",
    stats: { models, tools: { byName: {} } } }, null, 2)}`;
  assert.deepEqual(parseGemini(print(stats(1, 0))), { inputTokens: 9356, requests: 1, toolCalls: 0,
    model: "gemini-3.6-flash", contextWindow: 1_048_576, reply: "OK" });
  assert.equal(parseGemini(print(stats(3, 1))).inputTokens, null);
});

test("Kimi: the newest turn of the session log and the window its config gives the model", () => {
  const turn = tokens => [{ type: "agent.turn.started" },
    { type: "llm.request", modelAlias: "kimi-code/k3.1-pro" },
    { type: "usage.record", usage: { inputOther: tokens, inputCacheRead: 100, inputCacheCreation: 0 } }];
  const wire = [...turn(12_000), ...turn(13_000)].map(line => JSON.stringify(line)).join("\n");
  const config = '[models."kimi-code/k3.1-pro"]\nmax_context_size = 262144\n[models."other"]\nmax_context_size = 1\n';
  assert.deepEqual(parseKimi(wire, config), { inputTokens: 13_100, requests: 1, toolCalls: 0,
    model: "kimi-code/k3.1-pro", contextWindow: 262_144, reply: null });
});

test("a surface is the median sample; tables say when no count was possible", () => {
  assert.equal(median([141, 139, 150]), 141);
  assert.equal(median([null, 7]), 7);
  assert.equal(median([null]), null);
  assert.match(withData("x"), /<data>\nx\n<\/data>$/);
  const turn = inputTokens => ({ label: "t", inputTokens, requests: 1, toolCalls: 0 });
  const table = renderTables({ clients: [{ client: "codex", version: "v", model: "m", contextWindow: 1000,
    surfaces: { skill: { bytes: 10, tokens: 5, samples: [5, 5, 5] } },
    sessions: { baseline: [turn(100)], installed: [turn(null)] } }] });
  assert.match(table, /\| skill \| 10 \| 5 \| 5, 5, 5 \| 0\.50% \|/);
  assert.match(table, /\| installed \| 1 \| n\/a \| 100 \| n\/a \|/);
});

// The surfaces are rendered by the checkout's own hooks, with no client and no model.
test("every surface renders from a real store: owner header, peers, three messages, reminders", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "acc-surfaces-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  await mkdir(project);
  await run("git", ["init", "-q", project]);
  const env = { HOME: path.join(root, "home"), PATH: process.env.PATH, ACC_NO_UPDATE_CHECK: "1",
    TMPDIR: os.tmpdir() };
  const texts = await renderSurfaces({ packageRoot: path.resolve(import.meta.dirname, "..", ".."),
    project, dataHome: path.join(root, "data"), env });

  assert.match(texts.ownerHeader, /^ACC CLI \(append\): --session session_\S+ --generation generation_/);
  assert.match(texts.peersPresent, /2 peer participants present/);
  assert.equal(texts.busyTurn.split("```acc-peer-message").length - 1, 3, texts.busyTurn);
  assert.match(texts.afterBusy, /Pending: /);
  assert.match(texts.claudeWake, /^ACC: new peer message message_/);
  assert.equal(skillListing("---\nname: acc\ndescription: Use when ACC reports peers.\n---\n"),
    "Use when ACC reports peers.");
});
