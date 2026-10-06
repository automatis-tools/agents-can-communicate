// Real Claude Code and Codex, against a model stub on 127.0.0.1, through the
// installed package. Their own hook runners start ACC's hooks - on Windows the
// Node shims in each client's own shell form - so this is the check that a
// Windows machine's clients attach, see each other and carry a message into the
// next turn. It needs both clients on PATH and ACC_REAL_CLIENTS=1; the
// windows-clients CI job installs them and sets it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { resolveExecutable, runExecutable } from "../../packages/adapter-sdk/src/executables.mjs";
import { startModelStub, promptText } from "../helpers/model-stub.mjs";
import { createPackedAcc } from "../helpers/packed-acc.mjs";

const run = promisify(execFile);
const skip = process.env.ACC_REAL_CLIENTS === "1" ? false
  : "set ACC_REAL_CLIENTS=1 with claude and codex on PATH; the windows-clients CI job does";

// The owner header the SessionStart hook put in front of the model, as the stub
// received it. Its arguments are what the agent appends to its own commands.
function ownerArguments(requests) {
  for (const request of [...requests].reverse()) {
    const match = /ACC CLI \(append\): (--session \S+ --generation \S+ --cwd (?:"[^"]*"|'[^']*') --workspace (?:"[^"]*"|'[^']*'))/
      .exec(promptText(request));
    if (match !== null) {
      return [...match[1].matchAll(/(--\w+) (?:"([^"]*)"|'([^']*)'|(\S+))/g)]
        .flatMap(([, flag, doubled, single, bare]) => [flag, doubled ?? single ?? bare]);
    }
  }
  return null;
}

// What to read when an attach did not happen: the client's own output, how long
// the turn took, and every line its logs wrote about hooks.
async function evidence(label, outcome, { logs = null, started }) {
  const lines = [`${label} took ${Math.round(performance.now() - started)}ms`,
    `stderr: ${String(outcome.stderr ?? "").slice(-3000)}`,
    `stdout: ${String(outcome.stdout ?? "").slice(-1500)}`];
  if (logs !== null) {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(logs, { recursive: true }).catch(() => []);
    for (const name of files.filter(file => /\.(log|jsonl)$/.test(file))) {
      const text = await readFile(path.join(logs, name), "utf8").catch(() => "");
      const hooks = text.split(/\r?\n/).filter(line => /hook/i.test(line)).slice(-40);
      if (hooks.length > 0) lines.push(`${name}:`, ...hooks.map(line => `  ${line.slice(0, 400)}`));
    }
  }
  return lines.join("\n");
}

async function client(command, args, { cwd, env, timeout = 180_000 }) {
  const file = await resolveExecutable(command, { pathEnv: env.PATH ?? env.Path });
  assert.notEqual(file, null, `${command} is not on PATH`);
  const pending = runExecutable(file, args, { cwd, env, timeout, maxBuffer: 16 << 20 });
  pending.child?.stdin?.end();
  return pending;
}

test("real Claude Code and Codex attach through their hooks and carry a message into the next turn",
  { skip, timeout: 900_000 }, async t => {
    const packed = await createPackedAcc(t);
    const stub = await startModelStub({ reply: "noted" });
    t.after(() => stub.close());
    const bins = await Promise.all(["claude", "codex"].map(command => resolveExecutable(command)));
    // POSIX hooks run `sh`, which lives outside the clients' directories.
    const system = process.platform === "win32" ? [] : ["/usr/bin", "/bin"];
    const PATH = [...new Set([...bins.map(file => path.dirname(file)), path.dirname(process.execPath),
      ...system])].join(path.delimiter);
    const codexHome = path.join(packed.clientHome, ".codex");
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, "config.toml"), [
      "model = \"stub-model\"", "model_provider = \"stub\"", "",
      "[model_providers.stub]", "name = \"stub\"", `base_url = "${stub.url}/v1"`,
      "wire_api = \"responses\"", "env_key = \"STUB_API_KEY\"", "",
    ].join("\n"));
    const env = { ...packed.env, PATH, USERPROFILE: packed.clientHome, CODEX_HOME: codexHome,
      ANTHROPIC_BASE_URL: stub.url, ANTHROPIC_API_KEY: "sk-ant-stub", STUB_API_KEY: "stub",
      DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}),
      ...(process.env.LOCALAPPDATA ? { LOCALAPPDATA: process.env.LOCALAPPDATA,
        APPDATA: process.env.APPDATA, TEMP: process.env.TEMP, TMP: process.env.TMP } : {}) };
    const acc = async args => JSON.parse((await run(process.execPath, [packed.accBin, ...args, "--json"],
      { cwd: packed.project, env })).stdout).data;

    await acc(["install", "--adapter", "claude_code", "--adapter", "codex", "--delivery", "off",
      "--home", packed.clientHome]);
    // The real Codex reads ACC's rule: a coordination command is allowed, so no
    // approval and no auto-review sees it; install still asks (#260).
    const rules = path.join(codexHome, "rules", "agents-can-communicate.rules");
    if (process.platform !== "win32") {
      const shim = path.join(packed.clientHome, ".agents", "acc-local", "plugins",
        "agents-can-communicate", "acc-cli.sh");
      const decide = async (...words) => JSON.parse((await run(bins[1], ["execpolicy", "check",
        "--rules", rules, shim, ...words], { env })).stdout).decision ?? null;
      assert.equal(await decide("reply", "--message", "m", "--body", "b"), "allow");
      assert.equal(await decide("install", "--adapter", "codex"), null);
    } else {
      await assert.rejects(readFile(rules, "utf8"), { code: "ENOENT" });
    }
    // Someone is already in the room: a manual CLI session, the way an agent in
    // any other client would be. With a second live session, each client's
    // attachment is durable rather than ephemeral.
    const sender = await acc(["attach", "--participant", "e2e-sender"]);
    const owner = ["--session", sender.sessionId, "--generation", sender.generation];

    // Claude's first turn: SessionStart attaches it and puts the owner header in
    // front of the model.
    const claudeStarted = performance.now();
    const claudeRun = await client("claude", ["-p", "first turn", "--output-format", "json"],
      { cwd: packed.project, env });
    const claudeFirst = JSON.parse(claudeRun.stdout);
    assert.notEqual(ownerArguments(stub.requests.filter(item => item.url.includes("/messages"))), null,
      "no owner header reached Claude's model: its SessionStart hook did not attach it\n"
        + await evidence("claude -p", claudeRun, { started: claudeStarted }));

    // Codex's first turn attaches it the same way.
    const codexStarted = performance.now();
    const codexFirst = await client("codex", ["exec", "--skip-git-repo-check",
      "--dangerously-bypass-hook-trust", "first turn"], { cwd: packed.project, env });
    const codexSession = /session id: ([0-9a-f-]{36})/.exec(codexFirst.stderr)?.[1];
    assert.equal(typeof codexSession, "string", codexFirst.stderr);
    assert.notEqual(ownerArguments(stub.requests.filter(item => item.url.includes("/responses"))), null,
      "no owner header reached Codex's model: its SessionStart hook did not attach it\n"
        + await evidence("codex exec", codexFirst, { logs: codexHome, started: codexStarted }));

    // Both turns have ended, so both sessions are closed, and a message to either
    // waits for its next turn. A manual CLI session sends it, the way an agent in
    // any other client would.
    const { snapshot } = await acc(["sync", "--scope", "full", ...owner]);
    const sessions = Object.values(snapshot.sessions ?? {}).concat(Array.isArray(snapshot.sessions)
      ? snapshot.sessions : []);
    const participant = harness => sessions.find(item => item?.harness === harness)?.participantId;
    assert.equal(typeof participant("claude_code"), "string", JSON.stringify(snapshot).slice(0, 1500));
    assert.equal(typeof participant("codex"), "string", JSON.stringify(snapshot).slice(0, 1500));
    await acc(["message", "--to", participant("codex"), "--type", "note", "--subject", "to codex",
      "--body", "PEER-BODY-FOR-CODEX", ...owner]);
    const before = stub.requests.length;
    await client("codex", ["exec", "resume", codexSession, "--skip-git-repo-check",
      "--dangerously-bypass-hook-trust", "second turn"], { cwd: packed.project, env });
    const codexSecond = stub.requests.slice(before).filter(item => item.url.includes("/responses"));
    assert.equal(codexSecond.some(item => promptText(item).includes("PEER-BODY-FOR-CODEX")), true,
      "the message did not reach Codex's model on its next turn");

    await acc(["message", "--to", participant("claude_code"), "--type", "note", "--subject",
      "to claude", "--body", "PEER-BODY-FOR-CLAUDE", ...owner]);
    const again = stub.requests.length;
    await client("claude", ["-p", "--resume", claudeFirst.session_id, "second turn",
      "--output-format", "json"], { cwd: packed.project, env });
    const claudeSecond = stub.requests.slice(again).filter(item => item.url.includes("/messages"));
    assert.equal(claudeSecond.some(item => promptText(item).includes("PEER-BODY-FOR-CLAUDE")), true,
      "the message did not reach Claude's model on its next turn");

    await acc(["uninstall", "--adapter", "claude_code", "--adapter", "codex", "--home", packed.clientHome]);
    const config = await readFile(path.join(codexHome, "config.toml"), "utf8");
    assert.equal(config.includes("agents-can-communicate"), false, config);
    await assert.rejects(readFile(rules, "utf8"), { code: "ENOENT" });
  });
