#!/usr/bin/env node
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { createMachine, observeHooks, observeBindingDiagnostic } from "./codex-local-daemon-machine.mjs";
import { assertRunEvidence } from "./codex-local-daemon-evidence.mjs";
import { finalizeHarnessRun } from "./codex-local-daemon-runner.mjs";
import { transportScenarios } from "./codex-local-daemon-transport.mjs";

const { values } = parseArgs({ options: Object.fromEntries(
  ["tarball", "codex", "phase", "output", "until-case", "cases", "legacy-tarball"].map(key => [key, { type: "string" }])), strict: true });
for (const key of ["tarball", "codex", "phase", "output"]) assert.ok(values[key], `--${key} is required`);
const startedAt = new Date().toISOString();
let h;
let failed = false;
let failure;
let setupFailure;
try {
  h = await createMachine(values);
  h.scenarios = [];
  h.debugStatus = process.env.ACC_E2E_DEBUG === "1";
  h.untilCase = values["until-case"];
  h.legacyTarball = values["legacy-tarball"];
  h.caseFilter = values.cases?.split(",");
  if (h.caseFilter && !h.untilCase) throw new Error("selected cases require an explicitly partial diagnostic");
  console.log(JSON.stringify({ phase: h.phase, clientVersion: h.version, stage: "installed" }));
  await observeHooks(h);
  if (process.env.ACC_E2E_BIND_DIAGNOSTIC === "1") {
    if (!h.untilCase) throw new Error("binding diagnostic requires an explicitly incomplete run");
    await observeBindingDiagnostic(h);
  }
  if (h.phase === "transport") await transportScenarios(h);
  else {
    const { productScenarios } = await import("./codex-local-daemon-scenarios.mjs");
    await productScenarios(h);
  }
} catch (error) {
  failed = true;
  setupFailure = error.harness;
  failure = { stage: error.harness ? "setup-or-scenario" : "runner", error: error.message };
  console.error(JSON.stringify({ phase: values.phase, stage: "failed", error: error.message }));
} finally {
  const result = await finalizeHarnessRun({ h, setupFailure, output: values.output,
    startedAt, failed, failure, validate: assertRunEvidence });
  if (!result.complete) process.exitCode = 1;
  console.log(JSON.stringify({ stage: "cleanup", ...result.cleanup }));
}
