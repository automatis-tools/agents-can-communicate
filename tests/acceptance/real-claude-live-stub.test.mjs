// Real Claude Code in its interactive terminal, against a model stub on
// 127.0.0.1, with ACC's live delivery on: a question from another session wakes
// the idle session through its own inbox - a Unix socket on POSIX, a named pipe
// with the peer key on Windows - and the model reads it without anyone typing.
// It needs claude on PATH, a terminal driver (Python; pywinpty on Windows) and
// ACC_REAL_CLIENTS=1; the real-clients CI job has all three.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { resolveExecutable } from "../../packages/adapter-sdk/src/executables.mjs";
import { promptText, startModelStub } from "../helpers/model-stub.mjs";
import { createPackedAcc } from "../helpers/packed-acc.mjs";
import { startTerminal } from "../helpers/pty.mjs";

const run = promisify(execFile);
const skip = process.env.ACC_REAL_CLIENTS === "1" ? false
  : "set ACC_REAL_CLIENTS=1 with claude on PATH and a terminal driver; the real-clients CI job does";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(label, read, { timeoutMs, intervalMs = 500, evidence }) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() >= end) assert.fail(`${label}\n${await evidence()}`);
    await delay(intervalMs);
  }
}

test("a question wakes an idle Claude Code session through its inbox", { skip, timeout: 600_000 }, async t => {
  const packed = await createPackedAcc(t);
  const stub = await startModelStub({ reply: "noted" });
  // Stopped before the fixture directory goes, newest first: the client, whose
  // hooks write into the data home while it lives, the stub, and then whatever
  // runtime worker those hooks started.
  packed.defer(() => packed.workersQuiet());
  packed.defer(() => stub.close());
  const claude = await resolveExecutable("claude");
  assert.notEqual(claude, null, "claude is not on PATH");
  const system = process.platform === "win32" ? [] : ["/usr/bin", "/bin"];
  const PATH = [...new Set([path.dirname(claude), path.dirname(process.execPath), ...system])]
    .join(path.delimiter);
  const apiKey = "sk-ant-stub-key-0123456789abcdefghij";
  // A test started from inside a Claude Code session inherits its markers, and
  // a client that sees them runs as that session's child.
  const inherited = Object.fromEntries(Object.entries(packed.env)
    .filter(([key]) => !/^CLAUDE(CODE|_CODE_|_PID|_PROJECT_DIR|_ENV_FILE)/i.test(key)));
  const env = { ...inherited, PATH, USERPROFILE: packed.clientHome, ANTHROPIC_BASE_URL: stub.url,
    ANTHROPIC_API_KEY: apiKey, DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1", TERM: "xterm-256color",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec,
      LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA, TEMP: process.env.TEMP,
      TMP: process.env.TMP } : {}) };
  // The first-run screens a person clicks through once: onboarding, the API key
  // and the folder's trust.
  const projects = Object.fromEntries([packed.project, packed.project.replaceAll("\\", "/")].map(key =>
    [key, { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] }]));
  await writeFile(path.join(packed.clientHome, ".claude.json"), JSON.stringify({
    hasCompletedOnboarding: true, theme: "dark", numStartups: 3,
    customApiKeyResponses: { approved: [apiKey.slice(-20)], rejected: [] }, projects }));
  const acc = async args => JSON.parse((await run(process.execPath, [packed.accBin, ...args, "--json"],
    { cwd: packed.project, env })).stdout).data;

  await acc(["install", "--adapter", "claude_code", "--delivery", "actionable", "--home", packed.clientHome]);
  const sender = await acc(["attach", "--participant", "e2e-sender"]);
  const owner = ["--session", sender.sessionId, "--generation", sender.generation];

  const argv = /\.(cmd|bat)$/i.test(claude) ? ["cmd.exe", "/d", "/s", "/c", claude] : [claude];
  const terminal = await startTerminal(argv, { cwd: packed.project, env,
    log: path.join(packed.clientHome, "claude-screen.log") });
  packed.defer(() => terminal.close());
  const evidence = async () => {
    const doctor = await acc(["doctor"]).catch(error => ({ error: String(error.stderr ?? error) }));
    const claudeDoctor = (doctor.adapters ?? []).find(item => item.adapterId === "claude_code") ?? doctor;
    return `screen:\n${await terminal.screen()}\nstub requests: ${stub.requests.length}\n`
      + `doctor: ${JSON.stringify(claudeDoctor?.nativeDelivery ?? claudeDoctor).slice(0, 2500)}`;
  };

  // SessionStart attaches the session and binds it to its inbox.
  const participant = await until("the Claude Code session never attached", async () => {
    const status = await acc(["status", ...owner]).catch(() => null);
    if (status === null) return null;
    const live = JSON.stringify(status);
    const found = (status.participants ?? []).find(item => item?.harness === "claude_code"
      || item?.client === "claude_code");
    return found?.participantId ?? (/"participantId":"(claude_code-[^"]+)"/.exec(live)?.[1] ?? null);
  }, { timeoutMs: 120_000, intervalMs: 2000, evidence });

  const before = stub.requests.length;
  const sent = await until("the question was not offered through the inbox", async () => {
    const result = await acc(["message", "--to", participant, "--type", "question", "--subject", "live",
      "--body", "LIVE-BODY-FOR-CLAUDE", ...owner]);
    return JSON.stringify(result).includes("claude-inbox") ? result : null;
  }, { timeoutMs: 60_000, intervalMs: 5000, evidence });

  // Nobody types: the wake runs a turn, and ACC's own hook projects the message.
  await until("the woken turn did not reach the model with the question", async () =>
    stub.requests.slice(before).some(request => promptText(request).includes("LIVE-BODY-FOR-CLAUDE")),
  { timeoutMs: 120_000, evidence: async () => `${await evidence()}\nsent: ${JSON.stringify(sent).slice(0, 1500)}` });
});
