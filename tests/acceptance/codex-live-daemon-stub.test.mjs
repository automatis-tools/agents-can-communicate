// Real Codex, its app-server daemon and ACC's live delivery, against a model
// stub on 127.0.0.1, through the installed package. A thread runs one turn in
// the daemon, so its hooks attach it; a CLI session then sends it a message, and
// the check is that ACC offers it through the daemon and the message reaches the
// model in a turn the daemon starts. It needs codex on PATH and
// ACC_REAL_CLIENTS=1. On Windows the daemon refuses an elevated token, so the CI
// job runs this file as a standard user (scripts/ci-standard-user.mjs).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { resolveExecutable, runExecutable } from "../../packages/adapter-sdk/src/executables.mjs";
import { powershellCandidates } from "../../packages/adapter-sdk/src/process-table.mjs";
import { controlSocketPath, hooksForDirectories, initializeCodex, openCodexAppServer }
  from "../../packages/adapter-codex/src/app-server-client.mjs";
import { startModelStub, promptText } from "../helpers/model-stub.mjs";
import { createPackedAcc } from "../helpers/packed-acc.mjs";

const run = promisify(execFile);
const skip = process.env.ACC_REAL_CLIENTS === "1" ? false
  : "set ACC_REAL_CLIENTS=1 with codex on PATH; the real-clients CI job does";

const tomlString = value => JSON.stringify(value);

// Codex's daemon leaves helpers of its own (a pid-update-loop, an updater)
// running from its install inside CODEX_HOME after `daemon stop`. They would
// outlive the test and, on Windows, hold the client home it removes.
// On Windows through PowerShell by absolute path, without a module path
// inherited from another PowerShell, which Windows PowerShell cannot load.
async function stopProcessesUnder(directory) {
  if (process.platform === "win32") {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
    for (const shell of powershellCandidates(process.env)) {
      const stopped = await run(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and"
          + " $_.ExecutablePath.StartsWith($env:ACC_STOP_UNDER, 'OrdinalIgnoreCase') }"
          + " | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
      { env: { ...env, ACC_STOP_UNDER: directory }, timeout: 60_000 }).then(() => true, () => false);
      if (stopped) return;
    }
  } else {
    await run("pkill", ["-f", "--", directory]).catch(() => {});
  }
}

// Each step is logged as it starts: a run that stops answering is then
// placed by the last line it printed.
const step = label => process.stderr.write(`codex-live: ${label}\n`);

async function until(label, check, { timeoutMs = 120_000, everyMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(everyMs);
  }
}

test("a peer message reaches an idle Codex thread through the app-server daemon",
  { skip, timeout: 900_000 }, async t => {
    // After-hooks run in the order they are registered, and the packed fixture
    // removes the client home in its own. The daemon lives in that home, so it
    // is stopped first.
    let stopDaemon = async () => {};
    t.after(async () => { step("stopping the daemon"); await stopDaemon(); step("stopped the daemon"); });
    step("packing ACC");
    const packed = await createPackedAcc(t);
    const stub = await startModelStub({ reply: "noted" });
    t.after(async () => { step("closing the model stub"); await stub.close(); });
    const codex = await resolveExecutable("codex");
    assert.notEqual(codex, null, "codex is not on PATH");
    const system = process.platform === "win32" ? [] : ["/usr/bin", "/bin"];
    const PATH = [...new Set([path.dirname(codex), path.dirname(process.execPath), ...system])]
      .join(path.delimiter);
    const codexHome = path.join(packed.clientHome, ".codex");
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, "config.toml"), [
      "model = \"stub-model\"", "model_provider = \"stub\"", "",
      "[model_providers.stub]", "name = \"stub\"", `base_url = "${stub.url}/v1"`,
      "wire_api = \"responses\"", "env_key = \"STUB_API_KEY\"", "",
      `[projects.${tomlString(packed.project)}]`, "trust_level = \"trusted\"", "",
    ].join("\n"));
    const env = { ...packed.env, PATH, USERPROFILE: packed.clientHome, CODEX_HOME: codexHome,
      STUB_API_KEY: "stub",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}),
      ...(process.env.LOCALAPPDATA ? { LOCALAPPDATA: process.env.LOCALAPPDATA,
        APPDATA: process.env.APPDATA, TEMP: process.env.TEMP, TMP: process.env.TMP } : {}) };
    const acc = async args => JSON.parse((await run(process.execPath, [packed.accBin, ...args, "--json"],
      { cwd: packed.project, env })).stdout).data;

    // An install that leaves an adapter unprepared exits non-zero, and its
    // report on stdout names what stopped it.
    const install = async () => JSON.parse((await run(process.execPath, [packed.accBin, "install",
      "--adapter", "codex", "--delivery", "actionable", "--home", packed.clientHome, "--json"],
    { cwd: packed.project, env }).catch(error => (typeof error.stdout === "string" && error.stdout.trim()
      ? error : Promise.reject(error)))).stdout);
    step("installing ACC for Codex");
    let reported = await install();
    stopDaemon = async () => {
      // codex is an npm .cmd shim on Windows, which execFile cannot start.
      await runExecutable(codex, ["app-server", "daemon", "stop"], { env, timeout: 30_000 }).catch(() => {});
      await stopProcessesUnder(codexHome);
    };
    // Codex 0.165.0 and 0.172.0 install the Linux daemon executable with mode
    // 0777 (#446). ACC refuses it and names the repair; a person runs that
    // command and installs again, and so does this check.
    for (let repairs = 0; repairs < 3 && process.platform !== "win32"; repairs += 1) {
      const refused = reported.ok === false
        ? reported.error?.details?.failed?.find(item => item.adapterId === "codex")?.error ?? "" : "";
      const repair = /run chmod go-w "([^"]+)", then retry acc install/.exec(refused);
      if (!repair) break;
      step(`running the repair ACC named: chmod go-w ${repair[1]}`);
      await run("chmod", ["go-w", repair[1]]);
      reported = await install();
    }
    const service = reported.data?.operations?.[0]?.nativeServiceSetup;
    if (service?.state !== "ready") {
      // What ACC compared when it refused the daemon: Codex's own account of
      // it, its pid file, and the command line the system reports for that pid.
      const version = await runExecutable(codex, ["app-server", "daemon", "version"], { env, timeout: 30_000 })
        .then(({ stdout }) => stdout.trim(), error => `version failed: ${error.message}`);
      const pidFile = await readFile(path.join(codexHome, "app-server-daemon", "daemon.pid"), "utf8")
        .catch(error => `daemon.pid: ${error.code}`);
      const pid = Number(/"pid"\s*:\s*(\d+)/.exec(pidFile)?.[1]);
      const command = process.platform === "win32" && pid > 0
        ? await run(powershellCandidates(process.env)[0], ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}") | ForEach-Object { $_.CommandLine; $_.CreationDate }`],
        { timeout: 60_000 }).then(({ stdout }) => stdout.trim(), error => `process read failed: ${error.message}`)
        : await run("ps", ["-p", String(pid), "-o", "lstart=,command="]).then(({ stdout }) => stdout.trim(), () => "");
      assert.fail(`the Codex daemon is not ready: ${JSON.stringify(service)}\nversion: ${version}\n`
        + `daemon.pid: ${pidFile}\nprocess: ${command}\nreport: ${JSON.stringify(reported).slice(0, 4000)}`);
    }

    step("connecting to the daemon");
    const peer = openCodexAppServer({ socketPath: controlSocketPath(env), timeoutMs: 30_000 });
    t.after(() => peer.close?.());
    await initializeCodex(peer);
    // A person trusts the hooks in Codex's review once; this is that answer,
    // written through the daemon so its loaded configuration has it at once.
    const [{ hooks }] = await hooksForDirectories(peer, [packed.project]);
    const ours = hooks.filter(hook => hook.pluginId === "agents-can-communicate-hooks@acc-local");
    assert.equal(ours.length, 5, JSON.stringify(hooks));
    await peer.request("config/batchWrite", { reloadUserConfig: true, edits: [{ keyPath: "hooks.state",
      mergeStrategy: "upsert", value: Object.fromEntries(ours.map(hook => {
        const [definition, content] = hook.currentHash.split("/");
        return [hook.key, { trusted_hash: definition, trusted_content_hash: content }];
      })) }] });
    const [{ hooks: trusted }] = await hooksForDirectories(peer, [packed.project]);
    assert.deepEqual(trusted.filter(hook => hook.pluginId === "agents-can-communicate-hooks@acc-local")
      .map(hook => hook.trustStatus), Array(5).fill("trusted"));

    // Someone is already in the room, the way an agent in any other client would be.
    const sender = await acc(["attach", "--participant", "e2e-sender"]);
    const owner = ["--session", sender.sessionId, "--generation", sender.generation];

    // One turn in a daemon thread: its SessionStart hook attaches it and binds
    // the thread to the daemon's endpoint.
    step("starting a daemon thread");
    const started = await peer.request("thread/start", { cwd: packed.project });
    const threadId = started?.thread?.id;
    assert.equal(typeof threadId, "string", JSON.stringify(started));
    await peer.request("turn/start", { threadId, input: [{ type: "text", text: "first turn" }] });
    const participant = await until("the Codex participant", async () => {
      const { snapshot } = await acc(["sync", "--scope", "full", ...owner]);
      const sessions = Object.values(snapshot.sessions ?? {});
      return sessions.find(item => item?.harness === "codex")?.participantId;
    });
    await until("the first turn to end", async () => {
      const listed = await peer.request("thread/turns/list", { threadId, limit: 1, itemsView: "notLoaded" });
      return listed?.data?.[0]?.status === "completed";
    });

    // The thread is idle. The send records the message and offers it through
    // the daemon, which starts a turn with it.
    step("sending the peer message");
    const before = stub.requests.length;
    const sent = await acc(["message", "--to", participant, "--type", "question", "--subject", "live",
      "--body", "PEER-BODY-LIVE-FOR-CODEX", ...owner]);
    assert.deepEqual(sent.delivery.map(item => item.outcome), ["offered"], JSON.stringify(sent.delivery));
    await until("the message to reach the model", () => stub.requests.slice(before)
      .some(item => item.url.includes("/responses") && promptText(item).includes("PEER-BODY-LIVE-FOR-CODEX")));

    step("uninstalling");
    await acc(["uninstall", "--adapter", "codex", "--home", packed.clientHome]);
  });
