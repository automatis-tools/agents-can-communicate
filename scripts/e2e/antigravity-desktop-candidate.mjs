#!/usr/bin/env node
// A private test build, never a release certificate. The captured desktop push
// (fixtures/desktop-2.19.1.json) lets the SDK construct the desktop protocol's
// anchor, so the installed desktop route can be exercised end to end; only the
// product run that follows can certify it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const { values } = parseArgs({ options: { tarball: { type: "string" }, output: { type: "string" } },
  strict: true });
for (const value of Object.values(values)) assert.ok(path.isAbsolute(value));
const transport = "fixtures/desktop-2.19.1.json";
const root = await mkdtemp(path.join(tmpdir(), "acc-antigravity-desktop-candidate-"));
try {
  await run("tar", ["-xzf", values.tarball, "-C", root]);
  const adapter = path.join(root, "package/node_modules/@agents-can-communicate/adapter-antigravity");
  const source = path.join(adapter, "src/adapter.mjs");
  let text = await readFile(source, "utf8");
  const anchor = "anchors: [{ version: ANTIGRAVITY_CLI_VERSION, protocolContract: PROTOCOL_CONTRACT }],";
  assert.ok(text.includes(anchor), `adapter.mjs lost the anchor ${anchor}`);
  text = text.replace(anchor, "anchors: [{ version: ANTIGRAVITY_CLI_VERSION, protocolContract: PROTOCOL_CONTRACT },\n"
    + "        { version: \"2.19.1\", protocolContract: \"antigravity-desktop-agentapi-v1\", client: \"antigravity-desktop\" }],");
  await writeFile(source, text);
  const manifestPath = path.join(adapter, "certification.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.evidence.push({ client: "antigravity-desktop", version: "2.19.1", platform: "darwin-arm64",
    observedAt: "2026-10-04", capability: "delivery.livePush", fixture: transport,
    provenance: "fixtures/private-desktop-provenance.json", provenanceId: "transport-only",
    idleBehavior: "offered", busyBehavior: "unobserved", authorityLevel: "experimental",
    limitations: ["Private candidate anchor from the captured desktop push; the installed desktop route is uncertified until its product run passes."],
    result: "pass" });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(adapter, "fixtures/private-desktop-provenance.json"), `${JSON.stringify({
    source: "real-client-capture", phase: "transport",
    fixtureSha256: sha256(await readFile(path.join(adapter, transport))),
    implementationPackageSha256: sha256(await readFile(values.tarball)) }, null, 2)}\n`);
  await run("tar", ["-czf", values.output, "-C", root, "package"]);
  console.log(JSON.stringify({ privateCandidate: values.output, sha256: sha256(await readFile(values.output)),
    releaseCertifiable: false }));
} finally {
  await rm(root, { recursive: true, force: true });
}
