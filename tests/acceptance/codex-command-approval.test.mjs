import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { resolveExecutable } from "../../packages/adapter-sdk/src/executables.mjs";
import { createPackedAcc } from "../helpers/packed-acc.mjs";
import { startCommandModel } from "../helpers/codex-approval-stub.mjs";

const run = promisify(execFile);
const skip = process.env.ACC_REAL_CLIENTS !== "1" ? "set ACC_REAL_CLIENTS=1 with Codex on PATH"
  : process.platform === "win32" ? "POSIX command rule and sandbox capture; Windows has no ACC rule" : false;
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const flags = owner => ["--session", owner.sessionId, "--generation", owner.generation];

test("real Codex executes packed ACC reads and carries local evidence to approval without bypassing denial",
  { skip, timeout: 180_000 }, async t => {
    const binary = await resolveExecutable("codex");
    assert.ok(binary, "Codex must be installed for the real-client job");
    const packed = await createPackedAcc(t);
    const version = (await run(binary, ["--version"])).stdout.trim();
    await packed.setClientVersions({ codex: version.replace(/^codex-cli /, "") });
    const codexHome = path.join(packed.clientHome, ".codex");
    await mkdir(codexHome, { recursive: true });
    await packed.acc(["install", "--adapter", "codex", "--delivery", "off", "--home", packed.clientHome]);
    const plugin = path.join(packed.clientHome, ".agents", "acc-local", "plugins", "agents-can-communicate");
    const skill = await readFile(path.join(plugin, "skills", "acc", "SKILL.md"), "utf8");
    const options = [...skill.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
    assert.equal(options[0]?.sandbox_permissions, "use_default", "installed default invocation is missing");
    const author = await packed.acc(["attach", "--participant", "fixture-author"]);
    const reader = await packed.acc(["attach", "--participant", "fixture-reader"]);
    await packed.hook("codex", { hook_event_name: "SessionStart",
      session_id: "fixture-native-room", cwd: packed.project });
    const hook = await packed.beforeTurn({ adapterId: "codex", harnessSessionId: "fixture-native-room" });
    const room = /--workspace ['"](acc:\/\/[a-f0-9]{64})['"]/.exec(hook.stdout)?.[1];
    assert.ok(room, `no local room reference: ${hook.stdout}\n${hook.stderr}`);
    const sent = (await packed.acc(["message", ...flags(author), "--to", "fixture-reader", "--type", "note",
      "--subject", "local history fixture", "--body", "SYNTHETIC_LOCAL_RECORD",
      "--client-message-id", "fixture-history"])).message;
    const args = [path.join(plugin, "acc-cli.sh"), "sync", "--scope", "history", "--message", sent.messageId,
      "--json", ...flags(reader), "--cwd", packed.project, "--workspace", room];
    const cmd = args.map(shellQuote).join(" ");
    const history = () => packed.acc(["sync", "--scope", "history", "--message", sent.messageId, ...flags(reader)]);
    const before = await history();

    async function execute(nextCall, review = () => false, grants = "") {
      const stub = await startCommandModel({ nextCall, review });
      packed.defer(() => stub.close());
      await writeFile(path.join(codexHome, "config.toml"), [
        'model = "stub-model"', 'model_provider = "stub"', 'approval_policy = "on-request"',
        'approvals_reviewer = "auto_review"', 'default_permissions = "fixture"',
        '[permissions.fixture]', 'extends = ":read-only"', '[permissions.fixture.filesystem]',
        '":workspace_roots" = "write"', grants,
        // Test filesystem approval independently of the runner's network namespace.
        // GitHub Linux can refuse bwrap's private loopback setup before ACC starts.
        // Commands are fixed local ACC calls; update checks and live delivery are off.
        '[permissions.fixture.network]', 'enabled = true',
        '[model_providers.stub]', 'name = "stub"', `base_url = "${stub.url}/v1"`,
        'wire_api = "responses"', 'env_key = "STUB_API_KEY"', "",
      ].join("\n"));
      const env = { ...packed.env, PATH: process.env.PATH, CODEX_HOME: codexHome,
        STUB_API_KEY: "stub", USERPROFILE: packed.clientHome };
      const pending = run(binary, ["exec", "--skip-git-repo-check", "--json", "-C", packed.project,
        "Read one local fixture coordination record."], { cwd: packed.project, env, timeout: 45_000,
        maxBuffer: 4 << 20 });
      pending.child.stdin.end();
      const result = await pending;
      const outputs = stub.requests.filter(r => r.model === "stub-model")
        .flatMap(r => r.input ?? []).filter(item => item.type === "function_call_output");
      return { ...stub, result, outputs };
    }

    // This profile allows only the workspace, not slash-tmp or the ACC data home.
    // A matching rule must not be assumed to override a restricted active profile.
    const normal = await execute(outputs => outputs.length === 0 ? { cmd, ...options[0] } : null);
    const normalOutput = normal.outputs.at(-1)?.output ?? "";
    assert.ok(/SYNTHETIC_LOCAL_RECORD|state_access_denied/.test(normalOutput), normalOutput);
    assert.equal(normal.actions.length, 0, "default invocation unexpectedly requested approval");

    // Removing the rule proves an explicit configured state grant, rather than
    // the host's writable temp directories, is sufficient for the ordinary path.
    const rule = path.join(codexHome, "rules", "agents-can-communicate.rules");
    await rename(rule, `${rule}.fixture-disabled`);
    const granted = await execute(outputs => outputs.length === 0 ? { cmd, ...options[0] } : null,
      () => false, `${JSON.stringify(path.join(packed.dataHome, "acc"))} = "write"`);
    assert.match(granted.outputs.at(-1)?.output ?? "", /SYNTHETIC_LOCAL_RECORD/);
    assert.equal(granted.actions.length, 0);

    const fallback = await execute(outputs => outputs.length === 0 ? { cmd, ...options[0] }
      : outputs.length === 1 && String(outputs[0].output).includes("state_access_denied")
        ? { cmd, ...options[1] } : null,
    action => /Read local ACC coordination records/.test(action?.justification ?? "")
      && /acc:\/\/.*local filesystem/.test(action.justification)
      && /No conversation transcript/.test(action.justification));
    assert.equal(fallback.actions.length, 1, "sandbox failure did not reach the approval path exactly once");
    assert.equal(fallback.actions[0].justification, options[1].justification);
    assert.equal(fallback.actions[0].environment_id, "local");
    assert.ok(fallback.actions[0].command.some(part => part.includes(room)));
    assert.match(fallback.outputs.at(-1)?.output ?? "", /SYNTHETIC_LOCAL_RECORD/);
    assert.deepEqual((await history()).receipts, before.receipts, "history read changed another session's receipt");

    const sendCommand = key => [path.join(plugin, "acc-cli.sh"), "message", ...flags(author),
      "--to", "fixture-reader", "--type", "note", "--subject", "approval fixture", "--body", key,
      "--client-message-id", key, "--cwd", packed.project, "--workspace", room, "--json"]
      .map(shellQuote).join(" ");
    const messageIds = async () => {
      const page = await packed.acc(["sync", "--scope", "history", ...flags(reader)]);
      assert.equal(page.nextCursor, null, "fixture message comparison requires a complete page");
      return page.items.map(m => m.messageId).sort();
    };
    const beforeSend = await messageIds();
    const send = sendCommand("fixture-approved-send");
    const delivered = await execute(outputs => outputs.length === 0 ? { cmd: send, ...options[0] }
      : outputs.length === 1 && String(outputs[0].output).includes("state_access_denied")
        ? { cmd: send, ...options[2] } : null,
    action => /own agent sessions on this machine/.test(action?.justification ?? "")
      && /local client socket/.test(action.justification));
    assert.equal(delivered.actions.length, 1);
    assert.equal(delivered.actions[0].justification, options[2].justification);
    const resultLine = String(delivered.outputs.at(-1)?.output).split("\n")
      .find(line => line.startsWith('{"envelope_version":'));
    assert.ok(resultLine, JSON.stringify(delivered.outputs));
    const recorded = JSON.parse(resultLine).data.message;
    const exact = await packed.acc(["sync", "--scope", "history", "--message", recorded.messageId, ...flags(reader)]);
    assert.equal(exact.items[0].clientMessageId, "fixture-approved-send");
    const afterSend = await messageIds();
    assert.deepEqual(afterSend.filter(id => !beforeSend.includes(id)), [recorded.messageId]);

    const denied = await execute(outputs => outputs.length === 0
      ? { cmd: sendCommand("fixture-denied-send"), ...options[2] } : null);
    assert.equal(denied.actions.length, 1);
    assert.doesNotMatch(denied.outputs.at(-1)?.output ?? "", /SYNTHETIC_LOCAL_RECORD/);
    assert.match(denied.outputs.at(-1)?.output ?? "", /reject/i);
    // The scripted controller issues one request. This checks Codex enforcement,
    // not whether an autonomous model follows the skill's no-bypass instruction.
    assert.equal(denied.outputs.length, 1);
    assert.deepEqual(await messageIds(), afterSend, "reviewer denial allowed a message to be recorded");
    assert.deepEqual((await history()).receipts, before.receipts);
    t.diagnostic(JSON.stringify({ codex: version,
      ordinaryRead: normalOutput.includes("state_access_denied") ? "sandbox denied" : "read",
      grantedReadReviews: granted.actions.length, fallbackReadReviews: fallback.actions.length,
      sendReviews: delivered.actions.length, deniedSendRecorded: false, historyReceiptsChanged: false }));
  });
