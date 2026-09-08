#!/usr/bin/env node
// Actual independently packed mutations. Only named failing assertions count.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { createMachine, observeHooks, run, sha256 } from "./codex-local-daemon-machine.mjs";
import { identify, launch } from "./codex-local-daemon-actions.mjs";
import { productIsolation, productSetup } from "./codex-local-daemon-product-base.mjs";
import { changePolicy } from "./codex-local-daemon-product-policy.mjs";

const { values } = parseArgs({ options: Object.fromEntries(
  ["tarball", "codex", "output", "mutation"].map(key => [key, { type: "string" }])), strict: true });
for (const key of ["tarball", "codex", "output"]) assert.ok(path.isAbsolute(values[key]));
assert.ok(["remote-wrapper", "wrong-thread", "cwd-validation"].includes(values.mutation));
await mkdir(values.output, { recursive: true });
const temporary = await mkdtemp("/private/tmp/acc-product-mutant-");
const tarball = path.join(values.output, "mutant.tgz");
const expected = values.mutation === "remote-wrapper"
  ? "ordinary launch must preserve receiver B in hooks, actual cwd and daemon metadata"
  : values.mutation === "wrong-thread" ? "only exact B1 executes an automatic turn"
    : "same Codex thread must reject A cwd";
const report = { source: "controlled-installed-package-mutation", mutation: values.mutation,
  originalPackageSha256: sha256(await readFile(values.tarball)), expectedFailure: expected,
  startedAt: new Date().toISOString(), caught: false };
let h;
async function replace(file, before, after) {
  const text = await readFile(file, "utf8");
  assert.equal(text.split(before).length, 2, "exact mutation occurs once");
  await writeFile(file, text.replace(before, after));
}
try {
  await run("tar", ["-xzf", values.tarball, "-C", temporary]);
  const adapter = path.join(temporary, "package/node_modules/@agents-can-communicate/adapter-codex/src");
  if (values.mutation === "remote-wrapper") {
    await replace(path.join(adapter, "adapter.mjs"), 'activationKinds: ["native-service"]',
      'activationKinds: ["native-service", "shell-bootstrap"]');
    await replace(path.join(adapter, "native-delivery.mjs"),
      "      applyCommand: null, teardownCommand: null },",
      '      applyCommand: null, teardownCommand: null },\n'
      + '    { kind: "shell-bootstrap", command: "codex", realExecutable, prefixArgs: ["--remote", "unix://"] },');
  } else if (values.mutation === "wrong-thread") {
    await replace(path.join(adapter, "native-delivery.mjs"),
      "      await addCodexQueueMessage(peer, { threadId: endpoint.threadId,",
      '      const siblings = await peer.request("thread/list", { useStateDbOnly: true, limit: 100 });\n'
      + '      const wrong = siblings.data.find(item => item.id !== endpoint.threadId && item.cwd === endpoint.cwd);\n'
      + '      await addCodexQueueMessage(peer, { threadId: wrong?.id ?? endpoint.threadId,');
  } else {
    await replace(path.join(adapter, "native-delivery.mjs"),
      "const located = await locateCodexThread(peer, { threadId: endpoint.threadId, cwd: endpoint.cwd });",
      "const located = await locateCodexThread(peer, { threadId: endpoint.threadId, cwd: undefined });");
  }
  await run("tar", ["-czf", tarball, "-C", temporary, "package"]);
  report.mutantPackageSha256 = sha256(await readFile(tarball));
  assert.notEqual(report.originalPackageSha256, report.mutantPackageSha256);
  h = await createMachine({ tarball, codex: values.codex,
    phase: values.mutation === "cwd-validation" ? "transport" : "product", output: values.output });
  h.scenarios = [];
  await observeHooks(h);
  if (values.mutation === "remote-wrapper") {
    // An actual loaded ordinary client makes the install-time queue probe eligible.
    await launch(h, "receiver-b2"); await identify(h, "receiver-b2");
    await changePolicy(h, "actionable");
    await stat(path.join(h.dataHome, "acc/bin/codex"));
  }
  try {
    if (values.mutation === "cwd-validation") {
      await launch(h, "receiver-b1");
      const receiver = await identify(h, "receiver-b1");
      const native = await h.module("adapter-codex/src/native-delivery.mjs");
      const result = await native.bindNativeSession({
        event: { sessionId: receiver.threadId, cwd: h.A },
        clientPid: receiver.clientPid, clientVersion: h.version,
        runtimeDir: receiver.runtimeDir, env: h.env, timeoutMs: 3_000,
      });
      assert.deepEqual([result.supported, result.opaqueEndpointRef, result.modes,
        result.reasonCode], [false, null, [], "workspace_identity_unavailable"], expected);
    } else {
      await productSetup(h);
      if (values.mutation === "wrong-thread") await productIsolation(h);
    }
    throw new Error("mutant unexpectedly passed");
  } catch (error) {
    assert.ok(error.message.includes(expected), `unrelated failure: ${error.message}`);
    report.caught = true;
    report.client = "codex-cli"; report.clientVersion = h.version;
    report.platform = `${process.platform}-${process.arch}`;
  }
} catch (error) {
  report.failure = error.message; process.exitCode = 1;
} finally {
  report.cleanup = h ? await h.cleanup() : { attempted: false, outcome: "unobserved" };
  await rm(temporary, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  if (!report.caught || report.cleanup.outcome !== "passed") process.exitCode = 1;
  await writeFile(path.join(values.output, "mutation.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}
