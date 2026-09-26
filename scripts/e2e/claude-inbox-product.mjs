#!/usr/bin/env node
// Records the Claude Code inbox wake's installed-product run, one case at a
// time, and writes the capture and its evidence only when both validators
// accept them. Capture scaffolding: never shipped, never imported by product code.
//
//   add    --run <run.json> --case C01..C06 --message <id> [--delivery <acc message --json>]
//          [--events <acc sync --scope full --json>] [--transcript <receiver .jsonl>]
//          [--other-transcript <.jsonl>] [--first-message <id>] [--observe kind=outcome@iso]...
//          [--started-at <iso>]
//   finish --run <run.json> --client-version <x.y.z> --package-sha256 <hex> --fixture <id>
//          --out-dir <dir> [--limitation <text>]...
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { CLAUDE_INBOX_PRODUCT_CASES, assertClaudeInboxRunEvidence, observationsFrom, scenarioPasses }
  from "./claude-inbox-evidence.mjs";
import { INSTALLED_HOOKS_LAUNCH_MODE, validateCapture } from "../spikes/delivery-capture.mjs";

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({ args: rest, strict: true, options: {
  run: { type: "string" }, case: { type: "string" }, message: { type: "string" },
  delivery: { type: "string" }, events: { type: "string" }, transcript: { type: "string" },
  "other-transcript": { type: "string" }, "first-message": { type: "string" },
  observe: { type: "string", multiple: true }, "started-at": { type: "string" },
  "client-version": { type: "string" }, "package-sha256": { type: "string" },
  fixture: { type: "string" }, "out-dir": { type: "string" },
  limitation: { type: "string", multiple: true } } });
const now = () => new Date().toISOString();
const readRun = async () => JSON.parse(await readFile(values.run, "utf8").catch(() => "{\"scenarios\":[]}"));
const readJson = async file => (file ? JSON.parse(await readFile(file, "utf8")) : null);
const readLines = async file => (file ? (await readFile(file, "utf8")).split("\n").filter(Boolean)
  .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean) : []);

if (command === "add") {
  if (!Object.hasOwn(CLAUDE_INBOX_PRODUCT_CASES, values.case)) throw new Error("--case is C01..C06");
  const run = await readRun();
  const events = (await readJson(values.events))?.data?.events ?? [];
  const finishedAt = now();
  const observations = observationsFrom({ caseId: values.case, delivery: await readJson(values.delivery),
    events, transcript: await readLines(values.transcript),
    otherTranscript: values["other-transcript"] ? await readLines(values["other-transcript"]) : null,
    messageId: values.message, firstMessageId: values["first-message"] ?? null,
    observed: values.observe ?? [], at: finishedAt });
  const outcome = scenarioPasses(values.case, observations) ? "passed" : "failed";
  run.scenarios = run.scenarios.filter(item => item.caseId !== values.case);
  run.scenarios.push({ caseId: values.case, outcome, startedAt: values["started-at"] ?? finishedAt,
    finishedAt, messageId: values.message, observations });
  await writeFile(values.run, `${JSON.stringify(run, null, 2)}\n`);
  console.log(`${values.case} ${outcome}: ${observations.map(item => `${item.kind}=${item.outcome}`).join(", ")}`);
} else if (command === "finish") {
  const run = await readRun();
  const scenarios = [...run.scenarios].sort((a, b) => a.caseId.localeCompare(b.caseId));
  const passed = scenarios.filter(item => item.outcome === "passed").length;
  const startedAt = scenarios.map(item => item.startedAt).sort()[0];
  const finishedAt = scenarios.map(item => item.finishedAt).sort().at(-1);
  const evidence = assertClaudeInboxRunEvidence({ schemaVersion: 1, source: "real-client-capture",
    client: "claude-code", phase: "product", clientVersion: values["client-version"],
    platform: "darwin-arm64", packageSha256: values["package-sha256"], startedAt, finishedAt,
    scenarioCount: scenarios.length, passedCount: passed, failedCount: scenarios.length - passed,
    cleanup: { attempted: true, outcome: "passed", ownedProcesses: "stopped", temporaryState: "removed" },
    scenarios });
  const branch = caseId => scenarios.find(item => item.caseId === caseId)?.outcome === "passed";
  const capture = validateCapture({ client: "claude-code", version: values["client-version"],
    platform: "darwin-arm64", observedAt: finishedAt, capability: "native_delivery",
    result: passed === scenarios.length ? "pass" : "fail", fixture: values.fixture,
    launchMode: INSTALLED_HOOKS_LAUNCH_MODE, protocolContract: "claude-code-inbox-socket-v1",
    idle: branch("C01") ? "offered" : "unobserved",
    busy: branch("C02") ? "presented_between_tool_calls" : "unobserved",
    reply: branch("C03") ? "routed" : "unobserved",
    duplicate: branch("C04") ? "same_message_id" : "unobserved",
    fallback: branch("C05") ? "queued" : "unobserved",
    packageSha256: values["package-sha256"], limitations: values.limitation ?? [] },
  { productEvidence: evidence });
  await writeFile(path.join(values["out-dir"], `${values.fixture}.json`), `${JSON.stringify(capture, null, 2)}\n`);
  await writeFile(path.join(values["out-dir"], `${values.fixture}-product-evidence.json`),
    `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`${capture.result}: ${passed}/${scenarios.length} cases`);
} else {
  throw new Error("usage: claude-inbox-product.mjs add|finish ...");
}
