// Measurement only (throwaway branch): the Codex app-server daemon on Windows.
// What its help says, what an elevated and a non-elevated start do, what the
// daemon writes, and what `codex app-server proxy` speaks on stdio.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveExecutable, runExecutable } from "../packages/adapter-sdk/src/executables.mjs";
import { decodeFrames, encodeFrame } from "../packages/adapter-codex/src/ws-json-rpc.mjs";
import { startModelStub } from "../tests/helpers/model-stub.mjs";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const say = (...parts) => console.log(...parts);
const root = await mkdtemp(path.join(tmpdir(), "acc-codex-"));
const codexHome = path.join(root, "codex-home");
await mkdir(codexHome, { recursive: true });
const stub = await startModelStub({ reply: "noted" });
await writeFile(path.join(codexHome, "config.toml"), [
  "model = \"stub-model\"", "model_provider = \"stub\"", "",
  "[model_providers.stub]", "name = \"stub\"", `base_url = "${stub.url}/v1"`,
  "wire_api = \"responses\"", "env_key = \"STUB_API_KEY\"", "",
].join("\n"));
const env = { ...process.env, CODEX_HOME: codexHome, STUB_API_KEY: "stub" };
const codex = await resolveExecutable("codex", { pathEnv: process.env.PATH ?? process.env.Path });
say("codex executable:", codex);
const codexRun = async (args, timeout = 30_000) => runExecutable(codex, args, { env, timeout })
  .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
for (const args of [["--version"], ["app-server", "--help"], ["app-server", "proxy", "--help"],
  ["app-server", "daemon", "--help"], ["app-server", "daemon", "start", "--help"]]) {
  const outcome = await codexRun(args);
  say(`--- codex ${args.join(" ")} -> ${outcome.code}\n${outcome.stdout}${outcome.stderr}`);
}
say("--- whoami /groups (this step):");
say(execFileSync("whoami", ["/groups"]).toString().split(/\r?\n/).filter(line => /Mandatory Label/.test(line)).join("\n"));

const elevated = await codexRun(["app-server", "daemon", "start"], 60_000);
say(`--- elevated daemon start -> ${elevated.code}\n${elevated.stdout}${elevated.stderr}`);

const log = path.join(root, "daemon-start.log");
const script = path.join(root, "start-daemon.cmd");
await writeFile(script, [
  "@echo off",
  `set "CODEX_HOME=${codexHome}"`,
  "set \"STUB_API_KEY=stub\"",
  `whoami /groups | findstr /c:"Mandatory Label" > "${log}" 2>&1`,
  `call "${codex}" app-server daemon start >> "${log}" 2>&1`,
  `echo exit %ERRORLEVEL% >> "${log}"`,
  "",
].join("\r\n"));
const launched = await runExecutable("runas", ["/trustlevel:0x20000", `cmd /d /c "${script}"`],
  { env, timeout: 30_000 }).then(result => result, error => error);
say("runas /trustlevel:", launched.code ?? 0, String(launched.stdout ?? ""), String(launched.stderr ?? ""));
for (let second = 0; second < 60; second += 1) {
  if (existsSync(log) && /exit/.test(await readFile(log, "utf8").catch(() => ""))) break;
  await delay(1000);
}
say(`--- non-elevated start log:\n${await readFile(log, "utf8").catch(error => error.code)}`);

const listing = await readdir(codexHome, { recursive: true }).catch(() => []);
say("CODEX_HOME:", listing.filter(name => !/^(log|sessions|tmp)\b/.test(name)));
for (const name of listing.filter(file => /\.pid$|daemon|control/.test(file))) {
  const full = path.join(codexHome, name);
  const stat = lstatSync(full, { throwIfNoEntry: false });
  if (stat === undefined) continue;
  say(name, { file: stat.isFile(), dir: stat.isDirectory(), socket: stat.isSocket(),
    link: stat.isSymbolicLink(), size: stat.size, mode: stat.mode.toString(8) });
  if (stat.isFile() && stat.size < 4096) say("  content:", JSON.stringify(await readFile(full, "utf8")));
}

const proxy = (label, write, waitMs = 4000) => new Promise(resolve => {
  const child = spawn(/\.(cmd|bat)$/i.test(codex) ? "cmd.exe" : codex,
    [...(/\.(cmd|bat)$/i.test(codex) ? ["/d", "/s", "/c", `"${codex}" app-server proxy`] : ["app-server", "proxy"])],
    { env, stdio: ["pipe", "pipe", "pipe"], windowsVerbatimArguments: /\.(cmd|bat)$/i.test(codex) });
  let out = Buffer.alloc(0);
  let err = "";
  child.stdout.on("data", data => { out = Buffer.concat([out, data]); });
  child.stderr.on("data", data => { err += data; });
  write(child, () => out);
  setTimeout(() => {
    say(`--- proxy ${label}: stdout ${out.length} bytes ${JSON.stringify(out.subarray(0, 400).toString("latin1"))}`
      + `\nstderr ${JSON.stringify(err.slice(-800))} exit ${child.exitCode}`);
    child.kill();
    resolve(out);
  }, waitMs);
});

const upgrade = "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
  + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";
await proxy("websocket upgrade then initialize", async (child, output) => {
  child.stdin.write(upgrade);
  for (let waited = 0; waited < 3000 && !output().includes("\r\n\r\n"); waited += 100) await delay(100);
  if (!/^HTTP\/1\.1 101/.test(output().toString("latin1"))) return;
  child.stdin.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { clientInfo: { name: "acc-probe", title: "ACC probe", version: "0.0.0" },
      capabilities: { experimentalApi: true } } })));
  await delay(1500);
  const body = output().subarray(output().indexOf("\r\n\r\n") + 4);
  say("decoded frames:", decodeFrames(body).frames.map(frame => frame.payload.toString("utf8").slice(0, 400)));
  child.stdin.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })));
  child.stdin.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/loaded/list", params: {} })));
  await delay(1500);
  say("after thread/loaded/list:", decodeFrames(output().subarray(output().indexOf("\r\n\r\n") + 4)).frames
    .map(frame => frame.payload.toString("utf8").slice(0, 400)));
}, 9000);
await proxy("json-rpc line", child => {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { clientInfo: { name: "acc-probe", version: "0.0.0" }, capabilities: { experimentalApi: true } } })}\n`);
});

const stop = await codexRun(["app-server", "daemon", "stop"], 30_000);
say(`--- daemon stop -> ${stop.code}\n${stop.stdout}${stop.stderr}`);
await stub.close();
process.exit(0);
