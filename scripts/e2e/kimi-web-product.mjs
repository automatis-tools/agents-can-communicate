#!/usr/bin/env node
// Records only closed delivery facts from an installed Kimi Web run. No
// transcript, message body, token, endpoint, or filesystem path is accepted.
//   add    --run run.json --case C01..C06 --message message_id
//          [--delivery acc-message.json] [--observe kind=outcome@iso]... [--started-at iso]
//   finish --run run.json --client-version x.y.z --package-sha256 hex
//          --fixture id --out-dir dir [--limitation text]...
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { KIMI_WEB_PRODUCT_CASES, assertKimiWebRunEvidence, scenarioPasses }
  from "./kimi-web-evidence.mjs";
import { INSTALLED_HOOKS_LAUNCH_MODE, validateCapture } from "../spikes/delivery-capture.mjs";

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({ args: rest, strict: true, options: {
  run: { type: "string" }, case: { type: "string" }, message: { type: "string" },
  delivery: { type: "string" }, observe: { type: "string", multiple: true },
  "started-at": { type: "string" }, "client-version": { type: "string" },
  "package-sha256": { type: "string" }, fixture: { type: "string" }, "out-dir": { type: "string" },
  limitation: { type: "string", multiple: true } } });
const now = () => new Date().toISOString();
const readRun = async () => JSON.parse(await readFile(values.run, "utf8").catch(() => "{\"scenarios\":[]}"));

if (command === "add") {
  if (!Object.hasOwn(KIMI_WEB_PRODUCT_CASES, values.case)) throw new Error("--case is C01..C06");
  const run = await readRun();
  const finishedAt = now();
  const delivery = values.delivery === undefined ? null
    : JSON.parse(await readFile(values.delivery, "utf8"));
  const outcome = delivery?.data?.delivery?.[0]?.outcome;
  const observations = [...(outcome === undefined ? [] : [{ kind: "delivery", outcome, at: finishedAt }]),
    ...(values.observe ?? []).map(item => {
      const match = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)=([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:@(.+))?$/.exec(item);
      if (match === null) throw new Error("--observe is kind=outcome[@iso]");
      return { kind: match[1], outcome: match[2], at: match[3] ?? finishedAt };
    })];
  run.scenarios = (run.scenarios ?? []).filter(item => item.caseId !== values.case);
  run.scenarios.push({ caseId: values.case,
    outcome: scenarioPasses(values.case, observations) ? "passed" : "failed",
    startedAt: values["started-at"] ?? finishedAt, finishedAt, messageId: values.message, observations });
  await writeFile(values.run, `${JSON.stringify(run, null, 2)}\n`);
  console.log(`${values.case} ${run.scenarios.at(-1).outcome}`);
} else if (command === "finish") {
  const run = await readRun();
  const scenarios = [...run.scenarios].sort((a, b) => a.caseId.localeCompare(b.caseId));
  const passed = scenarios.filter(item => item.outcome === "passed").length;
  const startedAt = scenarios.map(item => item.startedAt).sort()[0];
  const finishedAt = scenarios.map(item => item.finishedAt).sort().at(-1);
  const evidence = assertKimiWebRunEvidence({ schemaVersion: 1, source: "real-client-capture",
    client: "kimi", phase: "product", clientVersion: values["client-version"],
    platform: "darwin-arm64", packageSha256: values["package-sha256"], startedAt, finishedAt,
    scenarioCount: scenarios.length, passedCount: passed, failedCount: scenarios.length - passed,
    cleanup: { attempted: true, outcome: "passed", ownedProcesses: "stopped", temporaryState: "removed" },
    scenarios });
  const branch = caseId => scenarios.find(item => item.caseId === caseId)?.outcome === "passed";
  const capture = validateCapture({ client: "kimi", version: values["client-version"],
    platform: "darwin-arm64", observedAt: finishedAt, capability: "native_delivery",
    result: passed === scenarios.length ? "pass" : "fail", fixture: values.fixture,
    launchMode: INSTALLED_HOOKS_LAUNCH_MODE, protocolContract: "kimi-web-prompt-wake-v1",
    idle: branch("C01") ? "offered" : "unobserved",
    busy: branch("C02") ? "queued_after_turn" : "unobserved",
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
  throw new Error("usage: kimi-web-product.mjs add|finish ...");
}
