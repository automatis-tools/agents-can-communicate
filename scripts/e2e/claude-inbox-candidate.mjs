#!/usr/bin/env node
// A private test build, never a release certificate. The captured inbox
// transport (fixtures/inbox-wake-2.1.282.json) lets the SDK construct the
// native contract, so the installed wake route can be exercised end to end;
// only the product run that follows can certify it.
//
//   node scripts/e2e/claude-inbox-candidate.mjs --tarball <packed.tgz> --output <candidate.tgz>
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const { values } = parseArgs({ options: { tarball: { type: "string" }, output: { type: "string" } },
  strict: true });
for (const value of Object.values(values)) assert.ok(path.isAbsolute(value));
const repo = fileURLToPath(new URL("../..", import.meta.url));
const transport = "fixtures/inbox-wake-2.1.282.json";
const root = await mkdtemp(path.join(tmpdir(), "acc-claude-inbox-candidate-"));
try {
  await run("tar", ["-xzf", values.tarball, "-C", root]);
  const adapter = path.join(root, "package/node_modules/@agents-can-communicate/adapter-claude-code");
  const source = path.join(adapter, "src/adapter.mjs");
  let text = await readFile(source, "utf8");
  for (const anchor of ["      delivery: { nextTurn: true },", "    startSession:", "import certification from"]) {
    assert.ok(text.includes(anchor), `adapter.mjs lost the anchor ${anchor}`);
  }
  text = text.replace("import certification from", "import { bindNativeSession, offerMessage, "
    + "planNativeActivation, probeNativeDelivery, refreshNativeSession, retireNativeSession } "
    + "from \"./inbox-delivery.mjs\";\nimport certification from");
  text = text.replace("      delivery: { nextTurn: true },", "      delivery: { nextTurn: true, livePush: true },");
  text = text.replace("    startSession:", `    nativeDelivery: {
      minimumByPlatform: { "darwin-arm64": "2.1.282" },
      anchors: [{ platform: "darwin-arm64", version: "2.1.282",
        protocolContract: "claude-code-inbox-socket-v1" }],
      knownBad: [], activationKinds: ["native-service"], policySource: "installation-record",
      offerKind: "wake",
    },
    probeNativeDelivery, planNativeActivation, bindNativeSession, refreshNativeSession,
    retireNativeSession, offerMessage,
    startSession:`);
  await writeFile(source, text);
  await copyFile(path.join(repo, "packages/adapter-claude-code", transport), path.join(adapter, transport));
  const manifestPath = path.join(adapter, "certification.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.evidence.push({ client: "claude-code", version: "2.1.282", platform: "darwin-arm64",
    observedAt: "2026-09-25T19:40:41.000Z", capability: "delivery.livePush", fixture: transport,
    provenance: "fixtures/private-transport-provenance.json", provenanceId: "transport-only",
    idleBehavior: "offered", busyBehavior: "presented_between_tool_calls", authorityLevel: "experimental",
    limitations: ["Private candidate anchor from the captured inbox transport; the installed wake route is uncertified until its product run passes."],
    result: "pass" });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(adapter, "fixtures/private-transport-provenance.json"), `${JSON.stringify({
    source: "real-client-capture", phase: "transport",
    fixtureSha256: sha256(await readFile(path.join(adapter, transport))),
    implementationPackageSha256: sha256(await readFile(values.tarball)) }, null, 2)}\n`);
  await run("tar", ["-czf", values.output, "-C", root, "package"]);
  console.log(JSON.stringify({ privateCandidate: values.output, sha256: sha256(await readFile(values.output)),
    releaseCertifiable: false }));
} finally {
  await rm(root, { recursive: true, force: true });
}
