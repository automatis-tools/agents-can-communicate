#!/usr/bin/env node
// A private test build, never a release certificate. Real transport evidence
// permits SDK construction so the installed product route can be exercised.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { assertRunEvidence } from "./codex-local-daemon-evidence.mjs";
import { validateTransportCapture } from "../spikes/delivery-capture.mjs";
import { run, sha256 } from "./codex-local-daemon-machine.mjs";

const { values } = parseArgs({ options: Object.fromEntries(
  ["tarball", "transport-evidence", "output"].map(key => [key, { type: "string" }])), strict: true });
for (const value of Object.values(values)) assert.ok(path.isAbsolute(value));
const evidence = assertRunEvidence(JSON.parse(await readFile(values["transport-evidence"], "utf8")));
assert.equal(evidence.source, "real-client-capture");
assert.equal(evidence.phase, "transport");
assert.equal(evidence.failedCount, 0);
assert.equal(evidence.clientVersion, "0.152.1");
assert.equal(evidence.platform, "darwin-arm64");
// The passed transport can anchor a later implementation build, whose own
// product matrix must pass; both exact artifact identities remain explicit.
const root = await mkdtemp("/private/tmp/acc-private-candidate-");
try {
  await run("tar", ["-xzf", values.tarball, "-C", root]);
  const pkg = path.join(root, "package");
  const adapter = path.join(pkg, "node_modules/@agents-can-communicate/adapter-codex");
  const source = path.join(adapter, "src/adapter.mjs");
  let text = await readFile(source, "utf8");
  assert.ok(text.includes("delivery: { nextTurn: true, livePush: false }"));
  text = text.replace('import certification from',
    'import { probeNativeDelivery, planNativeActivation, bindNativeSession, refreshNativeSession, retireNativeSession, offerMessage } from "./native-delivery.mjs";\nimport certification from');
  text = text.replace("delivery: { nextTurn: true, livePush: false }",
    "delivery: { nextTurn: true, livePush: true }");
  text = text.replace('    startSession:', `    nativeDelivery: {
      minimumByPlatform: { "darwin-arm64": CODEX_QUEUE_MINIMUM },
      anchors: [{ platform: "darwin-arm64", version: CODEX_QUEUE_MINIMUM,
        protocolContract: PROTOCOL_CONTRACT }], knownBad: [],
      activationKinds: ["native-service"], policySource: "installation-record",
    },
    probeNativeDelivery, planNativeActivation, bindNativeSession,
    refreshNativeSession, retireNativeSession, offerMessage,
    startSession:`);
  await writeFile(source, text);
  const capture = { schemaVersion: 1, client: "codex-cli", version: evidence.clientVersion,
    platform: evidence.platform, observedAt: evidence.finishedAt, capability: "native_delivery_transport",
    result: "pass", fixture: "codex-cli-0.152.1-local-daemon-transport", phase: "transport",
    packageSha256: evidence.packageSha256, protocolContract: "codex-app-server-thread-queue-v1",
    exactBinding: "receiver_thread_matched", idle: "queue_add_accepted", busy: "queued_while_active",
    rejectedSubmission: "observed", durableReceipt: "queued", limitations: [
      "Private SDK anchor from real installed-adapter transport only; full product routing remains uncertified.",
      "Historical explicit-remote workspace failure remains in its original fixture.",
    ] };
  validateTransportCapture(capture);
  const fixture = "fixtures/delivery/codex-cli-0.152.1-local-daemon-transport.json";
  const bytes = `${JSON.stringify(capture, null, 2)}\n`;
  await writeFile(path.join(adapter, fixture), bytes);
  await writeFile(path.join(adapter, "fixtures/delivery/private-transport-evidence.json"),
    `${JSON.stringify(evidence, null, 2)}\n`);
  const manifestPath = path.join(adapter, "certification.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.evidence = manifest.evidence.filter(item => !(item.version === "0.152.1"
    && item.capability === "delivery.livePush"));
  manifest.evidence.push({ client: "codex-cli", version: evidence.clientVersion,
    platform: evidence.platform, observedAt: evidence.finishedAt, capability: "delivery.livePush",
    fixture, provenance: "fixtures/private-transport-provenance.json", provenanceId: "transport-only",
    idleBehavior: "queue_add_accepted", busyBehavior: "queued_while_active", authorityLevel: "experimental",
    limitations: capture.limitations, result: "pass" });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(adapter, "fixtures/private-transport-provenance.json"), `${JSON.stringify({
    source: "real-client-capture", phase: "transport", fixtureSha256: sha256(bytes),
    observedPackageSha256: evidence.packageSha256, implementationPackageSha256: sha256(await readFile(values.tarball)),
  }, null, 2)}\n`);
  await run("tar", ["-czf", values.output, "-C", root, "package"]);
  console.log(JSON.stringify({ privateCandidate: values.output, sha256: sha256(await readFile(values.output)),
    releaseCertifiable: false, observedTransportPackageSha256: evidence.packageSha256 }));
} finally { await rm(root, { recursive: true, force: true }); }
