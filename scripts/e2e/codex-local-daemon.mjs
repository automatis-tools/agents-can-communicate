#!/usr/bin/env node
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { createMachine, observeHooks, observeBindingDiagnostic } from "./codex-local-daemon-machine.mjs";
import { assertRunEvidence } from "./codex-local-daemon-evidence.mjs";
import { transportScenarios } from "./codex-local-daemon-transport.mjs";

const { values } = parseArgs({ options: Object.fromEntries(
  ["tarball", "codex", "phase", "output", "until-case", "cases", "legacy-tarball"].map(key => [key, { type: "string" }])), strict: true });
for (const key of ["tarball", "codex", "phase", "output"]) assert.ok(values[key], `--${key} is required`);
const startedAt = new Date().toISOString();
let h;
let failed = false;
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
  console.error(JSON.stringify({ phase: values.phase, stage: "failed", error: error.message }));
  process.exitCode = 1;
} finally {
  if (h) {
    const cleanup = await h.cleanup();
    for (const record of h.scenarios) record.cleanup = cleanup;
    const result = { schemaVersion: 1, source: "real-client-capture", client: "codex-cli", phase: h.phase,
      clientVersion: h.version, platform: `${process.platform}-${process.arch}`,
      packageSha256: h.packageSha256, startedAt, finishedAt: new Date().toISOString(),
      scenarioCount: h.scenarios.length, passedCount: h.scenarios.length, failedCount: 0,
      cleanup, scenarios: h.scenarios };
    if (!failed && cleanup.outcome === "passed") {
      assertRunEvidence(result);
      await writeFile(path.join(values.output, "evidence.json"), `${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.exitCode = 1;
      // Incomplete runs cannot satisfy the passing aggregate validator. Keep
      // their closed observations and cleanup outcome under an explicit name.
      await writeFile(path.join(values.output, "incomplete-evidence.json"), `${JSON.stringify({
        complete: false, ...result }, null, 2)}\n`);
    }
    console.log(JSON.stringify({ stage: "cleanup", ...cleanup }));
  }
}
