#!/usr/bin/env node
// A private test build, never a release certificate. The captured agentapi
// transport (fixtures/agentapi-live-push-1.2.7.json) lets the SDK construct the
// native contract, so the installed relay route can be exercised end to end;
// only the product run that follows can certify it.
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
const transport = "fixtures/agentapi-live-push-1.2.7.json";
const root = await mkdtemp(path.join(tmpdir(), "acc-antigravity-candidate-"));
try {
  await run("tar", ["-xzf", values.tarball, "-C", root]);
  const adapter = path.join(root, "package/node_modules/@agents-can-communicate/adapter-antigravity");
  const source = path.join(adapter, "src/adapter.mjs");
  let text = await readFile(source, "utf8");
  for (const anchor of ["delivery: { nextTurn: true },", "    startSession:", "import certification from"]) {
    assert.ok(text.includes(anchor), `adapter.mjs lost the anchor ${anchor}`);
  }
  text = text.replace("import certification from", "import { bindNativeSession, offerMessage, "
    + "planNativeActivation, probeNativeDelivery, refreshNativeSession } from \"./native-delivery.mjs\";\n"
    + "import certification from");
  text = text.replace("delivery: { nextTurn: true },", "delivery: { nextTurn: true, livePush: true },");
  text = text.replace("    startSession:", `    nativeDelivery: {
      minimumByPlatform: { "darwin-arm64": "1.2.7" },
      anchors: [{ platform: "darwin-arm64", version: "1.2.7",
        protocolContract: "antigravity-agentapi-relay-v1" }],
      knownBad: [], activationKinds: ["native-config"], policySource: "installation-record",
    },
    probeNativeDelivery, planNativeActivation, bindNativeSession, refreshNativeSession, offerMessage,
    startSession:`);
  await writeFile(source, text);
  await copyFile(path.join(repo, "packages/adapter-antigravity", transport), path.join(adapter, transport));
  const manifestPath = path.join(adapter, "certification.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.evidence.push({ client: "antigravity-cli", version: "1.2.7", platform: "darwin-arm64",
    observedAt: "2026-09-21T17:03:49Z", capability: "delivery.livePush", fixture: transport,
    provenance: "fixtures/private-transport-provenance.json", provenanceId: "transport-only",
    idleBehavior: "offered", busyBehavior: "queued_after_turn", authorityLevel: "experimental",
    limitations: ["Private candidate anchor from the captured agentapi transport; the installed relay route is uncertified until its product run passes."],
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
