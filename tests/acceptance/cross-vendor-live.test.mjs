import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { connectMcp, PROTOCOL_META } from "../helpers/mcp-client.mjs";
import { createPackedAcc } from "../helpers/packed-acc.mjs";

const META = PROTOCOL_META("2026-07-28");
const CAPTURE_VERSIONS = Object.freeze({ claude: "2.1.252", codex: "0.152.0" });
const ADAPTER_IDS = Object.freeze(["claude_code", "codex", "gemini_cli", "grok", "kimi"]);

const operationIds = result => result.operations.map(operation => operation.adapterId);
const readJson = file => readFile(file, "utf8").then(JSON.parse);

async function exchange(packed, { from, to, subject, body, answer, key }) {
  const traceStart = packed.commandTrace.length;
  const sent = await packed.acc(["message", "--session", from.session.sessionId,
    "--to", to.participantId, "--type", "question", "--subject", subject,
    "--body", body, "--client-message-id", `${key}-question`]);
  const question = sent.message;
  assert.equal(question.threadId, question.messageId);
  assert.deepEqual(sent.delivery.map(item => item.outcome), ["queued"]);
  assert.equal((await packed.receipt(from.session.sessionId, question.messageId,
    to.participantId)).state, "queued");

  const projected = await packed.beforeTurn(to);
  assert.equal(projected.stdout.includes(body), false,
    "an uncertified native version was promoted to next-turn delivery");
  assert.equal((await packed.receipt(from.session.sessionId, question.messageId,
    to.participantId)).state, "queued");

  const inbox = await packed.acc(["inbox", "--session", to.session.sessionId,
    "--message", question.messageId]);
  assert.equal(inbox[0].message.messageId, question.messageId);
  assert.equal(inbox[0].message.body, body);
  assert.equal((await packed.receipt(from.session.sessionId, question.messageId,
    to.participantId)).state, "retrieved");

  const replied = await packed.acc(["reply", "--session", to.session.sessionId,
    "--message", question.messageId, "--body", answer,
    "--client-message-id", `${key}-answer`]);
  const response = replied.message;
  assert.equal(response.kind, "answer");
  assert.equal(response.threadId, question.threadId);
  assert.equal(response.inReplyTo, question.messageId);
  assert.equal((await packed.receipt(from.session.sessionId, question.messageId,
    to.participantId)).state, "acknowledged");

  const answerProjection = await packed.beforeTurn(from);
  assert.equal(answerProjection.stdout.includes(answer), false);
  const answerInbox = await packed.acc(["inbox", "--session", from.session.sessionId,
    "--message", response.messageId]);
  assert.equal(answerInbox[0].message.messageId, response.messageId);
  await packed.acc(["ack", "--session", from.session.sessionId,
    "--message", response.messageId]);
  assert.equal((await packed.receipt(to.session.sessionId, response.messageId,
    from.participantId)).state, "acknowledged");

  const sentAgain = await packed.acc(["message", "--session", from.session.sessionId,
    "--to", to.participantId, "--type", "question", "--subject", subject,
    "--body", body, "--client-message-id", `${key}-question`]);
  const replyAgain = await packed.acc(["reply", "--session", to.session.sessionId,
    "--message", question.messageId, "--body", answer,
    "--client-message-id", `${key}-answer`]);
  assert.equal(sentAgain.message.messageId, question.messageId);
  assert.equal(replyAgain.message.messageId, response.messageId);
  const trace = packed.commandTrace.slice(traceStart);
  const carries = value => trace.filter(args => args.includes(value));
  assert.deepEqual(carries(body).map(args => args[0]), ["message", "message"],
    "the responder command copied the peer's question body");
  assert.deepEqual(carries(answer).map(args => args[0]), ["reply", "reply"],
    "the original sender copied the peer's answer body");
  for (const args of carries(body)) {
    assert.equal(args[args.indexOf("--session") + 1], from.session.sessionId);
  }
  for (const args of carries(answer)) {
    assert.equal(args[args.indexOf("--session") + 1], to.session.sessionId);
  }
  return { question, answer: response };
}

test("packed v0.2 completes cross-vendor fallback without human relay", {
  timeout: 120_000,
  skip: process.platform === "win32"
    ? "v0.2 supports macOS/Linux; its native captures and POSIX client probes do not certify Windows"
    : false,
}, async t => {
  const packed = await createPackedAcc(t);
  assert.equal(packed.manifest.version, "0.2.0");
  assert.equal((await packed.acc(["version"])).version, "0.2.0");
  await packed.setClientVersions(CAPTURE_VERSIONS);

  const claude = { adapterId: "claude_code", participantId: "claude_peer",
    harnessSessionId: "claude-old" };
  const codex = { adapterId: "codex", participantId: "codex_peer",
    harnessSessionId: "codex-old" };
  claude.session = await packed.start(claude);
  codex.session = await packed.start(codex);
  assert.notEqual(claude.session, undefined);
  assert.notEqual(codex.session, undefined);

  await exchange(packed, { from: claude, to: codex, key: "claude-to-codex",
    subject: "Which package owns delivery?", body: "Name the delivery package.",
    answer: "The delivery-router package owns it." });
  await exchange(packed, { from: codex, to: claude, key: "codex-to-claude",
    subject: "What is the fallback?", body: "Name the durable fallback.",
    answer: "The addressed ACC inbox is the fallback." });

  const claudeBinding = await packed.findBinding(claude.harnessSessionId);
  const codexBinding = await packed.findBinding(codex.harnessSessionId);
  await packed.publishBinding({ sessionId: claudeBinding.accSessionId,
    generation: claudeBinding.generation, adapterId: claude.adapterId,
    clientVersion: CAPTURE_VERSIONS.claude });
  await packed.publishBinding({ sessionId: codexBinding.accSessionId,
    generation: codexBinding.generation, adapterId: codex.adapterId,
    clientVersion: CAPTURE_VERSIONS.codex });
  assert.equal((await packed.acc(["status"])).deliveryBindings.length, 2);

  await packed.acc(["finish", "--session", claude.session.sessionId,
    "--goal", "restart Claude", "--status", "complete"]);
  await packed.acc(["finish", "--session", codex.session.sessionId,
    "--goal", "restart Codex", "--status", "complete"]);
  assert.notEqual(await packed.findBinding(claude.harnessSessionId), null,
    "the test did not retain a stale binding to challenge owner resolution");

  await packed.setClientVersions({ claude: "99.0.0", codex: "99.0.0" });
  const restartedClaude = { ...claude, harnessSessionId: "claude-new" };
  const restartedCodex = { ...codex, harnessSessionId: "codex-new" };
  restartedClaude.session = await packed.start(restartedClaude);
  restartedCodex.session = await packed.start(restartedCodex);
  const newClaudeBinding = await packed.findBinding(restartedClaude.harnessSessionId);
  const newCodexBinding = await packed.findBinding(restartedCodex.harnessSessionId);
  assert.notEqual(newClaudeBinding.generation, claudeBinding.generation);
  assert.notEqual(newCodexBinding.generation, codexBinding.generation);
  assert.deepEqual((await packed.acc(["status"])).deliveryBindings, [],
    "closed generations kept their stale delivery endpoints reachable");
  assert.notEqual(await packed.accError(["work", "--session", claude.session.sessionId,
    "--summary", "stale owner"]), null);

  await packed.publishBinding({ sessionId: newCodexBinding.accSessionId,
    generation: newCodexBinding.generation, adapterId: "codex",
    clientVersion: "99.0.0" });
  const downgraded = await packed.acc(["message", "--session",
    restartedClaude.session.sessionId, "--to", restartedCodex.participantId,
    "--type", "question", "--subject", "Unknown version",
    "--body", "Can you still recover this?", "--client-message-id", "unknown-version"]);
  assert.equal(downgraded.delivery[0].errorCode, "unsupported_client_version");
  assert.equal((await packed.beforeTurn(restartedCodex)).stdout
    .includes("Can you still recover this?"), false);
  const recovered = await packed.acc(["inbox", "--session",
    restartedCodex.session.sessionId, "--message", downgraded.message.messageId]);
  assert.equal(recovered[0].message.messageId, downgraded.message.messageId);

  const mcp = connectMcp({ binary: packed.mcpBin, cwd: packed.project,
    dataHome: packed.dataHome, participant: "packed_observer",
    env: { ACC_MCP_WORKSPACE: packed.project } });
  t.after(() => mcp.close());
  const observed = await mcp.request("tools/call",
    { name: "acc_status", arguments: {}, _meta: META });
  assert.equal(observed.error, undefined, JSON.stringify(observed.error));
  await mcp.close();

  await mkdir(path.join(packed.clientHome, ".claude"), { recursive: true });
  await mkdir(path.join(packed.clientHome, ".codex"), { recursive: true });
  await writeFile(path.join(packed.clientHome, ".claude", "settings.json"),
    '{"foreign":true}\n');
  await writeFile(path.join(packed.clientHome, ".codex", "config.toml"),
    'foreign = "keep"\n');
  await mkdir(path.join(packed.clientHome, ".kimi-code"), { recursive: true });
  await writeFile(path.join(packed.clientHome, ".kimi-code", "config.toml"),
    'default_model = "k3"\n');
  const beforeInstall = await packed.snapshotClientFiles();
  const installed = await packed.acc(["install", "--home", packed.clientHome]);
  assert.deepEqual(installed.failed, []);
  assert.deepEqual(operationIds(installed), ADAPTER_IDS);
  assert.equal(installed.operations.every(operation => operation.applied), true);
  assert.notDeepEqual(await packed.snapshotClientFiles(), beforeInstall,
    "install did not change the client-home topology");

  const manifests = [
    ".claude/plugins/marketplaces/acc-local/agents-can-communicate/.claude-plugin/plugin.json",
    ".agents/acc-local/plugins/agents-can-communicate/.codex-plugin/plugin.json",
    ".gemini/extensions/agents-can-communicate/gemini-extension.json",
    ".kimi-code/plugins/managed/agents-can-communicate/.kimi-plugin/plugin.json",
  ];
  for (const manifest of manifests) {
    assert.equal((await readJson(path.join(packed.clientHome, manifest))).version, "0.2.0",
      `${manifest} was not stamped from the installed package`);
  }

  const uninstalled = await packed.acc(["uninstall", "--home", packed.clientHome]);
  assert.deepEqual(uninstalled.failed, []);
  assert.deepEqual(operationIds(uninstalled), ADAPTER_IDS);
  assert.equal(uninstalled.operations.every(operation => operation.applied), true);
  assert.equal(uninstalled.operations.some(operation =>
    (operation.removed?.length ?? 0) + (operation.changes?.length ?? 0) > 0), true,
  "first uninstall reported no removals");
  assert.deepEqual(await packed.snapshotClientFiles(), beforeInstall,
    "first uninstall did not restore the exact pre-install topology");

  const repeated = await packed.acc(["uninstall", "--home", packed.clientHome]);
  assert.deepEqual(repeated.failed, []);
  assert.deepEqual(operationIds(repeated), ADAPTER_IDS);
  assert.equal(repeated.operations.every(operation => operation.applied), true);
  assert.equal(repeated.operations.every(operation =>
    (operation.removed?.length ?? 0) === 0
      && (operation.removedDirectories?.length ?? 0) === 0
      && (operation.changes?.length ?? 0) === 0), true,
  `second uninstall was not an idempotent no-op: ${JSON.stringify(repeated.operations)}`);
  assert.deepEqual(await packed.snapshotClientFiles(), beforeInstall);
  assert.deepEqual(await readdir(packed.project), [],
    "packed ACC wrote runtime state into the user's project");
});
