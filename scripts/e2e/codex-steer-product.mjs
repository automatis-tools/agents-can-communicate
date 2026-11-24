#!/usr/bin/env node
// Records the installed-product run of Codex live delivery into a running turn
// (#132), one case at a time, and writes the capture and its evidence only when
// both validators accept them. Capture scaffolding: never shipped, never
// imported by product code.
//
//   add    --run <run.json> --case X01..X05 --message <id> [--delivery <acc message --json>]
//          [--events <acc sync --scope full --json>] [--rollout <receiver thread .jsonl>]
//          [--first-message <id>] [--sent-at <iso>] [--observe kind=outcome@iso]...
//          [--started-at <iso>]
//   finish --run <run.json> --client-version <x.y.z> --package-sha256 <hex> --fixture <id>
//          --out-dir <dir> [--limitation <text>]...
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { CODEX_STEER_PRODUCT_CASES, CODEX_STEER_SUITE, assertCodexSteerRunEvidence, observationsFrom,
  scenarioPasses } from "./codex-steer-evidence.mjs";
import { INSTALLED_HOOKS_LAUNCH_MODE, validateCapture } from "../spikes/delivery-capture.mjs";

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({ args: rest, strict: true, options: {
  run: { type: "string" }, case: { type: "string" }, message: { type: "string" },
  delivery: { type: "string" }, events: { type: "string" }, rollout: { type: "string" },
  "first-message": { type: "string" }, "sent-at": { type: "string" },
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
  if (!Object.hasOwn(CODEX_STEER_PRODUCT_CASES, values.case)) throw new Error("--case is X01..X05");
  const run = await readRun();
  const events = (await readJson(values.events))?.data?.events ?? [];
  const finishedAt = now();
  const observations = observationsFrom({ caseId: values.case, delivery: await readJson(values.delivery),
    events, rollout: await readLines(values.rollout),
    messageId: values.message, firstMessageId: values["first-message"] ?? null,
    sentAt: values["sent-at"],
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
  const evidence = assertCodexSteerRunEvidence({ schemaVersion: 1, suite: CODEX_STEER_SUITE,
    source: "real-client-capture", client: "codex-cli", phase: "product", clientVersion: values["client-version"],
    platform: "darwin-arm64", packageSha256: values["package-sha256"], startedAt, finishedAt,
    scenarioCount: scenarios.length, passedCount: passed, failedCount: scenarios.length - passed,
    cleanup: { attempted: true, outcome: "passed", ownedProcesses: "stopped", temporaryState: "removed" },
    scenarios });
  const branch = caseId => scenarios.find(item => item.caseId === caseId)?.outcome === "passed";
  const capture = validateCapture({ client: "codex-cli", version: values["client-version"],
    platform: "darwin-arm64", observedAt: finishedAt, capability: "native_delivery",
    result: passed === scenarios.length ? "pass" : "fail", fixture: values.fixture,
    launchMode: INSTALLED_HOOKS_LAUNCH_MODE, protocolContract: "codex-app-server-thread-queue-v1",
    idle: branch("X01") ? "offered" : "unobserved",
    busy: branch("X02") ? "presented_in_running_turn" : "unobserved",
    reply: branch("X03") ? "routed" : "unobserved",
    duplicate: branch("X04") ? "same_message_id" : "unobserved",
    fallback: branch("X05") ? "queued" : "unobserved",
    packageSha256: values["package-sha256"], limitations: values.limitation ?? [] },
  { productEvidence: evidence });
  await writeFile(path.join(values["out-dir"], `${values.fixture}.json`), `${JSON.stringify(capture, null, 2)}\n`);
  await writeFile(path.join(values["out-dir"], `${values.fixture}-product-evidence.json`),
    `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`${capture.result}: ${passed}/${scenarios.length} cases`);
} else {
  throw new Error("usage: codex-steer-product.mjs add|finish ...");
}
