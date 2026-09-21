#!/usr/bin/env node
// Records the Antigravity relay's installed-product run, one case at a time,
// and writes the capture and its evidence only when both validators accept
// them. Capture scaffolding: never shipped, never imported by product code.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { ANTIGRAVITY_PRODUCT_CASES, assertAntigravityRunEvidence, observationsFrom, scenarioPasses }
  from "./antigravity-relay-evidence.mjs";
import { INSTALLED_HOOKS_LAUNCH_MODE, validateCapture } from "../spikes/delivery-capture.mjs";

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({ args: rest, strict: true, options: {
  run: { type: "string" }, case: { type: "string" }, message: { type: "string" },
  delivery: { type: "string" }, "relay-log": { type: "string" },
  observe: { type: "string", multiple: true }, "started-at": { type: "string" },
  "client-version": { type: "string" }, "package-sha256": { type: "string" },
  fixture: { type: "string" }, "out-dir": { type: "string" },
  limitation: { type: "string", multiple: true } } });
const now = () => new Date().toISOString();
const readRun = async () => JSON.parse(await readFile(values.run, "utf8").catch(() => "{\"scenarios\":[]}"));

if (command === "add") {
  if (!Object.hasOwn(ANTIGRAVITY_PRODUCT_CASES, values.case)) throw new Error("--case is A01..A05");
  const run = await readRun();
  const delivery = values.delivery ? JSON.parse(await readFile(values.delivery, "utf8")) : null;
  const relayLog = values["relay-log"] ? await readFile(values["relay-log"], "utf8") : "";
  const finishedAt = now();
  const observations = observationsFrom({ caseId: values.case, delivery, relayLog,
    messageId: values.message, observed: values.observe ?? [], at: finishedAt });
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
  const evidence = assertAntigravityRunEvidence({ schemaVersion: 1, source: "real-client-capture",
    client: "antigravity-cli", phase: "product", clientVersion: values["client-version"],
    platform: "darwin-arm64", packageSha256: values["package-sha256"], startedAt, finishedAt,
    scenarioCount: scenarios.length, passedCount: passed, failedCount: scenarios.length - passed,
    cleanup: { attempted: true, outcome: "passed", ownedProcesses: "stopped", temporaryState: "removed" },
    scenarios });
  const branch = caseId => scenarios.find(item => item.caseId === caseId)?.outcome === "passed";
  const capture = validateCapture({ client: "antigravity-cli", version: values["client-version"],
    platform: "darwin-arm64", observedAt: finishedAt, capability: "native_delivery",
    result: passed === scenarios.length ? "pass" : "fail", fixture: values.fixture,
    launchMode: INSTALLED_HOOKS_LAUNCH_MODE, protocolContract: "antigravity-agentapi-relay-v1",
    idle: branch("A01") ? "offered" : "unobserved",
    busy: branch("A02") ? "queued_after_turn" : "unobserved",
    reply: branch("A03") ? "routed" : "unobserved",
    duplicate: branch("A04") ? "same_message_id" : "unobserved",
    fallback: branch("A05") ? "queued" : "unobserved",
    packageSha256: values["package-sha256"], limitations: values.limitation ?? [] },
  { productEvidence: evidence });
  await writeFile(path.join(values["out-dir"], `${values.fixture}.json`), `${JSON.stringify(capture, null, 2)}\n`);
  await writeFile(path.join(values["out-dir"], `${values.fixture}-evidence.json`),
    `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`${capture.result}: ${passed}/${scenarios.length} cases`);
} else {
  throw new Error("usage: antigravity-relay-product.mjs add|finish ...");
}
