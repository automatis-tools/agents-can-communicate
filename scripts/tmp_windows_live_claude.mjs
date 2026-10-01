// Measurement only (throwaway branch): Claude Code's live inbox on Windows.
// A real interactive Claude in a ConPTY against a model stub: what it publishes
// (session record, peer key, pipe), what its hooks see, and what a frame on the
// pipe does with no auth, with the peer key, and with a wrong token.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import { resolveExecutable } from "../packages/adapter-sdk/src/executables.mjs";
import { promptText, startModelStub } from "../tests/helpers/model-stub.mjs";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const say = (...parts) => console.log(...parts);
const hide = (key, value) => (/token/i.test(key) && typeof value === "string" ? `<${value.length} chars>` : value);
const redact = value => JSON.stringify(value, hide);
const plain = text => text.replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b[=>()][0-9A-Za-z]?/g, "");

const root = await mkdtemp(path.join(tmpdir(), "acc-live-"));
const home = path.join(root, "home");
const config = path.join(root, "claude-config");
const project = path.join(root, "project");
await Promise.all([home, config, project].map(dir => mkdir(dir, { recursive: true })));
const stub = await startModelStub({ reply: "noted" });
const apiKey = "sk-ant-stub-key-0123456789abcdefghij";
const projects = Object.fromEntries([project, project.replaceAll("\\", "/")].map(key =>
  [key, { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] }]));
const globalConfig = JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", numStartups: 3,
  customApiKeyResponses: { approved: [apiKey.slice(-20)], rejected: [] }, projects });
await writeFile(path.join(config, ".claude.json"), globalConfig);
await writeFile(path.join(home, ".claude.json"), globalConfig);
const dump = path.join(root, "hook-env.json");
const dumper = path.join(root, "dump.mjs");
await writeFile(dumper, `import { writeFileSync } from "node:fs";
let input = ""; process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ input,
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /CLAUDE|MESSAG/i.test(key))) })));\n`);
await writeFile(path.join(config, "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [
  { type: "command", command: `node "${dumper.replaceAll("\\", "/")}"` }] }] } }));

const env = { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_CONFIG_DIR: config,
  ANTHROPIC_BASE_URL: stub.url, ANTHROPIC_API_KEY: apiKey, DISABLE_TELEMETRY: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" };
const claude = await resolveExecutable("claude", { pathEnv: process.env.PATH ?? process.env.Path });
say("claude executable:", claude, execFileSync(process.execPath, ["-e",
  "console.log(process.versions.node)"]).toString().trim());
const argv = /\.(cmd|bat)$/i.test(claude) ? ["cmd.exe", "/d", "/s", "/c", claude] : [claude];
const screen = path.join(root, "screen.log");
await writeFile(screen, "");
const pty = spawn("python", [path.resolve("scripts/tmp_conpty.py"), JSON.stringify(argv), screen, project],
  { env, stdio: ["pipe", "pipe", "inherit"] });
say("conpty:", await new Promise(resolve => createInterface({ input: pty.stdout }).once("line", resolve)));
const send = text => pty.stdin.write(`${JSON.stringify({ op: "send", text })}\n`);
const tail = async (length = 1200) => plain(await readFile(screen, "utf8")).slice(-length);

const sessions = path.join(config, "sessions");
let record = null;
for (let second = 0; second < 90 && record === null; second += 1) {
  await delay(1000);
  const names = await readdir(sessions).catch(() => []);
  const json = names.find(name => /^\d+\.json$/.test(name));
  if (json) record = { name: json, value: JSON.parse(await readFile(path.join(sessions, json), "utf8")) };
  if (record === null && [20, 40, 60].includes(second)) {
    say(`--- no session record after ${second}s; screen:\n${await tail()}`);
    send("\r");
  }
}
say("--- screen once the record appeared or gave up:\n", await tail());
say("sessions dir:", await readdir(sessions).catch(error => error.code));
if (record === null) {
  say("no session record; stopping");
  pty.stdin.write(`${JSON.stringify({ op: "quit" })}\n`);
  await stub.close();
  process.exit(0);
}
say("session record", record.name, redact(record.value));

const keys = [];
for (const name of (await readdir(sessions)).filter(file => file.endsWith(".key"))) {
  const value = JSON.parse(await readFile(path.join(sessions, name), "utf8"));
  keys.push({ name, value });
  say("key file", name, redact(value),
    Object.fromEntries(Object.entries(value).map(([key, field]) => [key, typeof field])));
}
const pipes = readdirSync("\\\\.\\pipe\\").filter(name => /cc-msg|claude/i.test(name));
say("pipes:", pipes);
const hookDump = await readFile(dump, "utf8").then(JSON.parse).catch(error => ({ error: error.code }));
say("SessionStart hook env:", redact(hookDump.env ?? hookDump));

const socketPath = record.value.messagingSocketPath ?? hookDump.env?.CLAUDE_CODE_MESSAGING_SOCKET;
say("socket path:", socketPath);
for (const candidate of [socketPath, socketPath?.toLowerCase(), socketPath?.replace(/^\\\\[.?]\\pipe\\/i, ""),
  socketPath?.replace(/^\\\\[.?]\\pipe\\/i, "").toLowerCase(), pipes[0], `\\\\.\\pipe\\${pipes[0]}`]) {
  if (typeof candidate !== "string") continue;
  const hash = createHash("sha256").update(candidate).digest("hex");
  say("sha256 of", JSON.stringify(candidate), "matches a key file:", keys.some(key => key.name.includes(hash)));
}
try {
  const wmi = execFileSync("powershell.exe", ["-NoProfile", "-Command",
    `Get-CimInstance Win32_Process -Filter "ProcessId=${record.value.pid}" | ForEach-Object { `
    + "\"$($_.CreationDate.ToFileTimeUtc()) | $($_.ParentProcessId) | $($_.CommandLine)\" }"]).toString().trim();
  say("WMI creation FILETIME | parent | command line of the record's pid:", wmi);
} catch (error) {
  say("WMI read failed:", error.message);
}

const frame = marker => JSON.stringify({ type: "user",
  message: { role: "user", content: `ACC probe ${marker}` }, msg_id: `acc-wake-${marker}` });
async function talk(label, lines, waitMs) {
  const received = [];
  let closed = null;
  const socket = net.createConnection(socketPath);
  socket.on("data", data => received.push(String(data)));
  socket.on("close", hadError => { closed = { hadError }; });
  socket.on("error", error => received.push(`error ${error.code}`));
  const connected = await new Promise(resolve => {
    socket.once("connect", () => resolve(true));
    socket.once("error", () => resolve(false));
  });
  if (connected) for (const line of lines) socket.write(`${line}\n`);
  await delay(waitMs);
  say(label, redact({ connected, received, closed }));
  socket.destroy();
}
const reached = async (marker, waitMs) => {
  for (let waited = 0; waited < waitMs; waited += 500) {
    if (stub.requests.some(request => promptText(request).includes(`ACC probe ${marker}`))) return true;
    await delay(500);
  }
  return false;
};
const peer = keys.find(key => key.name.startsWith(`${record.value.pid}.`))?.value ?? keys[0]?.value;
await talk("no auth", [frame("A")], 3000);
say("turn with A reached the model:", await reached("A", 10_000));
await talk("wrong token", [JSON.stringify({ type: "auth", token: "0".repeat(32) }), frame("C")], 3000);
say("turn with C reached the model:", await reached("C", 10_000));
if (peer?.peerToken) {
  await talk("peer key", [JSON.stringify({ type: "auth", token: peer.peerToken }), frame("B")], 5000);
  say("turn with B reached the model:", await reached("B", 60_000));
}
say("--- final screen:\n", await tail(2500));
say("stub requests:", stub.requests.length);
pty.stdin.write(`${JSON.stringify({ op: "quit" })}\n`);
await delay(2000);
await stub.close();
process.exit(0);
