#!/usr/bin/env node
// Separate controlled transport diagnostic: never a positive product certificate.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { createMachine, observeHooks, shellLiteral, until } from "./codex-local-daemon-machine.mjs";
import { attachSender, identify, launch, queueState, receipt, sendMessage, threadState }
  from "./codex-local-daemon-actions.mjs";
import { binding, idle } from "./codex-local-daemon-product-state.mjs";

const { values } = parseArgs({ options: Object.fromEntries(
  ["tarball", "codex", "output"].map(key => [key, { type: "string" }])), strict: true });
let h;
const report = { schemaVersion: 1, source: "controlled-real-transport-failure", client: "codex-cli",
  startedAt: new Date().toISOString(), productCertified: false, result: "failed" };
try {
  h = await createMachine({ ...values, phase: "product" });
  await observeHooks(h);
  await launch(h, "receiver-b1");
  const b = await identify(h, "receiver-b1");
  await attachSender(h); await idle(h);
  const counter = path.join(h.B, "ambiguous-executions.txt");
  const count = () => readFile(counter, "utf8").then(text => text.trim().split("\n").length, () => 0);
  const sent = await sendMessage(h, { id: "ambiguous_ack", kind: "note", body:
    "Synthetic duplicate boundary diagnostic. Every time this diagnostic is presented, "
    + "including an identical repeated diagnostic, run exactly this shell command once and wait for it: "
    + `printf 'x\\n' >> ${shellLiteral(counter)}; sleep 25. Then answer DONE. Keep the session open.` });
  assert.equal(sent.delivery[0].outcome, "queued");
  assert.equal((await receipt(h, sent.message)).state, "queued");
  const { offerMessage } = await h.module("adapter-codex/src/native-delivery.mjs");
  const { openCodexAppServer } = await h.module("adapter-codex/src/app-server-client.mjs");
  let injected = false;
  const loseAcknowledgement = options => {
    const peer = openCodexAppServer(options);
    return { notify: (...args) => peer.notify(...args), close: () => peer.close(),
      async request(method, params) {
        const response = await peer.request(method, params);
        if (method === "thread/queue/add" && !injected) {
          injected = true;
          throw Object.assign(new Error("controlled lost queue acknowledgement"), { code: "ETIMEDOUT" });
        }
        return response;
      } };
  };
  const first = await offerMessage({ binding: await binding(h), message: sent.message,
    runtimeDir: b.runtimeDir, open: loseAcknowledgement });
  assert.equal(injected, true);
  assert.equal(first.accepted, false);
  assert.equal(first.safeErrorCode, "transport_error");
  await until("first diagnostic command began", async () => await count() === 1);
  assert.equal((await threadState(h, b.threadId)).status, "active");
  assert.equal((await queueState(h, b.threadId)).length, 0, "first queue entry was consumed");
  const beforeRetry = (await receipt(h, sent.message)).state;
  assert.ok(["queued", "retrieved", "acknowledged"].includes(beforeRetry));
  const second = await offerMessage({ binding: await binding(h), message: sent.message, runtimeDir: b.runtimeDir });
  assert.equal(second.accepted, true);
  assert.equal((await queueState(h, b.threadId)).filter(item =>
    item.clientMessageId === sent.message.messageId).length, 1);
  await until("same message executed a second command", async () => await count() === 2,
    { timeoutMs: 180_000 });
  await idle(h);
  assert.equal(await count(), 2);
  Object.assign(report, { result: "passed", clientVersion: h.version,
    platform: `${process.platform}-${process.arch}`, packageSha256: h.packageSha256,
    threadId: b.threadId, messageId: sent.message.messageId, lostAcknowledgement: "injected-after-acceptance",
    initialOffer: "transport_error", durableReceiptBeforeSubmission: "queued", durableReceiptBeforeRetry: beforeRetry,
    consumedBeforeRetry: true, retryAccepted: true, observedCommandExecutions: 2,
    limitation: "Queue idempotency applies while an entry remains pending; execution may repeat after consumption." });
} catch (error) {
  report.failure = error.message; process.exitCode = 1;
} finally {
  report.cleanup = h ? await h.cleanup() : { attempted: false, outcome: "unobserved" };
  report.finishedAt = new Date().toISOString();
  if (report.cleanup.outcome !== "passed") process.exitCode = 1;
  if (values.output) await writeFile(path.join(values.output, "ambiguous-ack.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}
