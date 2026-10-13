// Rehearsal fixture: real ACC CLI and filesystem, explicitly no LLM or native adapter.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const cli = path.resolve(option("--cli") ?? fileURLToPath(new URL("../../../bin/acc.mjs", import.meta.url)));
const evidencePath = option("--evidence");
const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-talk-demo-")));
const project = path.join(root, "project");
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ACC_")));
Object.assign(env, { ACC_DATA_HOME: path.join(root, "data"), ACC_NO_UPDATE_CHECK: "1" });
const terminal = args.includes("--step") ? createInterface({ input: process.stdin, output: process.stdout }) : null;
const facts = { kind: "real CLI / synthetic participants / no models / no native delivery", cli, steps: [] };

async function call(command, options = [], owner = null, expectedCode = 0) {
  const ownerFlags = owner ? ["--session", owner.sessionId, "--generation", owner.generation] : [];
  const result = await run(process.execPath, [cli, command, ...options, ...ownerFlags,
    "--cwd", project, "--json"], { env, timeout: 30_000, maxBuffer: 1024 * 1024 })
    .then(result => ({ ...result, code: 0 }))
    .catch(error => {
      if (typeof error.code !== "number") throw error;
      return error;
    });
  assert.equal(result.code, expectedCode, result.stderr || result.stdout);
  const envelope = JSON.parse(result.stdout);
  return expectedCode === 0 ? envelope.data : envelope;
}

async function show(label, detail) {
  facts.steps.push({ label, ...detail });
  console.log(`\n${label}\n${JSON.stringify(detail, null, 2)}`);
  if (terminal) await terminal.question("Enter to continue ");
}

async function receipt(owner, messageId) {
  const history = await call("sync", ["--scope", "history", "--message", messageId], owner);
  const text = JSON.stringify(history);
  return { history, text };
}

try {
  await mkdir(project);
  console.log("ACC transport rehearsal. These are synthetic CLI participants, not AI clients.");
  const codex = await call("attach", ["--participant", "demo-api"]);
  const claude = await call("attach", ["--participant", "demo-ui"]);
  await call("work", ["--summary", "defining the registration API", "--mode", "edit",
    "--hint", "file:api/**"], codex);
  await call("work", ["--summary", "building the registration form", "--mode", "edit",
    "--hint", "file:ui/**"], claude);
  await call("claim", ["--resource", "file:api/**", "--reason", "registration API"], codex);
  const conflict = await call("claim", ["--resource", "file:api/registration.mjs"], claude, 5);
  await show("1. Overlapping claim refuses the second reservation", { exit: 5, conflict: conflict.error });

  const questionFlags = ["--to", "demo-api", "--type", "question", "--subject", "Registration contract",
    "--body", "Which request and error fields should the form use?", "--client-message-id", "registration-question"];
  const sent = await call("message", questionFlags, claude);
  const message = sent.message ?? sent;
  assert.ok(message.messageId, "send must return its durable message id");
  const queued = await receipt(claude, message.messageId);
  assert.ok(queued.text.includes('"state":"queued"'), "a manual receiver must remain queued");
  await show("2. Message committed before any model or native transport", { messageId: message.messageId, state: "queued" });

  const retry = await call("message", questionFlags, claude);
  assert.equal((retry.message ?? retry).messageId, message.messageId, "same retry key must return the same message");
  const headers = await call("inbox", [], codex);
  assert.equal(headers.items.length, 1, "retry must not create a second inbox item");
  const afterHeaders = await receipt(claude, message.messageId);
  assert.ok(afterHeaders.text.includes('"state":"queued"'), "listing headers must not retrieve a message");
  await show("3. Safe retry and header-only inbox", { inboxItems: headers.items.length, sameMessageId: true, state: "queued" });

  await call("inbox", ["--message", message.messageId], codex);
  const retrieved = await receipt(claude, message.messageId);
  assert.ok(retrieved.text.includes('"state":"retrieved"'));
  await show("4. Exact inbox read is a stronger delivery fact", { state: "retrieved", modelAttentionProven: false });

  const answered = await call("reply", ["--message", message.messageId,
    "--body", "POST /register accepts email and password. 409 returns { code: EMAIL_TAKEN }.",
    "--client-message-id", "registration-answer"], codex);
  const acknowledged = await receipt(claude, message.messageId);
  assert.ok(acknowledged.text.includes('"state":"acknowledged"'));
  const reply = answered.reply ?? answered.message;
  assert.ok(reply?.messageId, "reply must return its own message id");
  await call("inbox", ["--message", reply.messageId], claude);
  await show("5. Reply resolves the communication obligation", { state: "acknowledged", answer: reply.body,
    taskCompletionProven: false });

  await call("release", ["--all"], codex);
  for (const owner of [codex, claude]) await call("detach", [], owner);
  await show("6. Rehearsal complete", { verified: ["claim conflict", "durable queue", "idempotent retry",
    "header listing preserves receipt", "exact retrieval", "reply acknowledges"], nativeDeliveryVerified: false });
  if (evidencePath) await writeFile(path.resolve(evidencePath), JSON.stringify(facts, null, 2) + "\n");
} finally {
  terminal?.close();
  await rm(root, { recursive: true, force: true });
}
