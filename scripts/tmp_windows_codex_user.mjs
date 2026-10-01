// Measurement only (throwaway branch), run as a standard user: the Codex
// app-server daemon on Windows, its files, and a queued message through
// `codex app-server proxy` into a thread the daemon runs against a model stub.
import { execFileSync, spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { runExecutable } from "../packages/adapter-sdk/src/executables.mjs";
import { decodeFrames, encodeFrame } from "../packages/adapter-codex/src/ws-json-rpc.mjs";
import { promptText, startModelStub } from "../tests/helpers/model-stub.mjs";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const say = (...parts) => console.log(...parts);
const codex = process.env.ACC_PROBE_CODEX;
const codexHome = process.env.CODEX_HOME;
const project = "C:\\ap\\proj";
await mkdir(codexHome, { recursive: true });
await mkdir(project, { recursive: true });
say("whoami:", execFileSync("whoami").toString().trim());
say(execFileSync("whoami", ["/groups"]).toString().split(/\r?\n/).filter(line => /Mandatory Label/.test(line)).join("\n"));
const stub = await startModelStub({ reply: "noted" });
await writeFile(path.join(codexHome, "config.toml"), [
  "model = \"stub-model\"", "model_provider = \"stub\"", "",
  "[model_providers.stub]", "name = \"stub\"", `base_url = "${stub.url}/v1"`,
  "wire_api = \"responses\"", "env_key = \"STUB_API_KEY\"", "",
].join("\n"));
const env = { ...process.env, STUB_API_KEY: "stub" };
const codexRun = async (args, timeout = 60_000) => runExecutable(codex, args, { env, timeout })
  .then(({ stdout, stderr }) => ({ code: 0, out: `${stdout}${stderr}` }),
    error => ({ code: error.code, out: `${error.stdout ?? ""}${error.stderr ?? ""}` }));

const started = await codexRun(["app-server", "daemon", "start"], 120_000);
say(`--- daemon start -> ${started.code}\n${started.out}`);
const version = await codexRun(["app-server", "daemon", "version"]);
say(`--- daemon version -> ${version.code}\n${version.out}`);
const listing = await readdir(codexHome, { recursive: true }).catch(() => []);
say("CODEX_HOME:", listing.filter(name => !/^(log|sessions|tmp|packages[\\/]app-server-daemon[\\/].+[\\/])/.test(name)));
for (const name of listing.filter(file => /\.pid$|\.lock$|\.sock$|settings\.json$/.test(file))) {
  const full = path.join(codexHome, name);
  let stat;
  try {
    stat = lstatSync(full, { throwIfNoEntry: false });
  } catch (error) {
    say(name, `lstat ${error.code}`);
    continue;
  }
  if (stat === undefined) continue;
  say(name, { file: stat.isFile(), socket: stat.isSocket(), link: stat.isSymbolicLink(), size: stat.size });
  if (stat.isFile() && stat.size < 4096 && !/\.lock$/.test(name)) {
    say("  content:", JSON.stringify(await readFile(full, "utf8")));
  }
}
const pidFile = listing.find(name => /app-server\.pid$/.test(name));
if (pidFile) {
  const pid = /\d+/.exec(await readFile(path.join(codexHome, pidFile), "utf8"))?.[0];
  try {
    say("WMI of the daemon pid:", execFileSync("powershell.exe", ["-NoProfile", "-Command",
      `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ForEach-Object { `
      + "\"$($_.CreationDate.ToFileTimeUtc()) | $($_.CommandLine)\" }"]).toString().trim());
  } catch (error) {
    say("WMI failed:", error.message);
  }
}

// One proxy, WebSocket JSON-RPC over its stdio.
const proxy = spawn("cmd.exe", ["/d", "/s", "/c", `"${codex}" app-server proxy`],
  { env, stdio: ["pipe", "pipe", "pipe"], windowsVerbatimArguments: true });
let buffer = Buffer.alloc(0);
let stderr = "";
let upgraded = false;
const responses = new Map();
const notifications = [];
proxy.stderr.on("data", data => { stderr += data; });
proxy.stdout.on("data", data => {
  buffer = Buffer.concat([buffer, data]);
  if (!upgraded) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end === -1) return;
    say("upgrade answer:", JSON.stringify(buffer.subarray(0, end).toString("latin1")));
    upgraded = true;
    buffer = buffer.subarray(end + 4);
  }
  const { frames, rest } = decodeFrames(buffer);
  buffer = rest;
  for (const frame of frames) {
    const message = JSON.parse(frame.payload.toString("utf8"));
    if (message.id !== undefined && responses.has(message.id)) responses.get(message.id)(message);
    else notifications.push(message.method);
  }
});
proxy.stdin.write("GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
  + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
let nextId = 0;
const request = (method, params, timeoutMs = 15_000) => new Promise(resolve => {
  const id = ++nextId;
  const timer = setTimeout(() => resolve({ timeout: method }), timeoutMs);
  responses.set(id, message => { clearTimeout(timer); resolve(message); });
  proxy.stdin.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
});
for (let waited = 0; waited < 5000 && !upgraded; waited += 100) await delay(100);
if (!upgraded) say(`no upgrade answer; proxy stderr: ${stderr.slice(-800)} exit ${proxy.exitCode}`);
else {
  const init = await request("initialize", { clientInfo: { name: "acc-probe", title: "ACC probe",
    version: "0.0.0" }, capabilities: { experimentalApi: true } });
  say("initialize:", JSON.stringify(init).slice(0, 300));
  proxy.stdin.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })));
  const thread = await request("thread/start", { cwd: project });
  say("thread/start:", JSON.stringify(thread).slice(0, 400));
  const threadId = thread?.result?.thread?.id;
  say("thread/loaded/list:", JSON.stringify(await request("thread/loaded/list", {})).slice(0, 300));
  if (typeof threadId === "string") {
    const before = stub.requests.length;
    const added = await request("thread/queue/add", { threadId,
      input: [{ type: "text", text: "ACC probe queued message" }], clientUserMessageId: "acc-probe-1" });
    say("thread/queue/add:", JSON.stringify(added).slice(0, 400));
    let reached = false;
    for (let waited = 0; waited < 60_000 && !reached; waited += 500) {
      reached = stub.requests.slice(before).some(item => promptText(item).includes("ACC probe queued message"));
      if (!reached) await delay(500);
    }
    say("queued message reached the model:", reached, "notifications:", [...new Set(notifications)].join(","));
  }
}
proxy.kill();
const stop = await codexRun(["app-server", "daemon", "stop"]);
say(`--- daemon stop -> ${stop.code}\n${stop.out}`);
await stub.close();
process.exit(0);
