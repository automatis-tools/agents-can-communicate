#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { openJsonRpcPeer, validateCapture } from "./json-rpc-peer.mjs";

const CERTIFIED_VERSION = "0.152.0";
const CLIENT = "codex-cli";
const UNOBSERVED = "unobserved";

const options = parseArgs(process.argv.slice(2));
const clientCommand = process.env.ACC_CODEX_SPIKE_COMMAND ?? "codex";
const version = readVersion(clientCommand);
const socketPath = process.env.ACC_CODEX_APP_SERVER_SOCKET
  ?? path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
    "app-server-control", "app-server-control.sock");

if (version !== CERTIFIED_VERSION) {
  captureFail(version, "installed client is not the certified codex-cli 0.152.0");
} else if (!existsSync(socketPath)) {
  captureFail(version, "daemon control socket absent; proxy was not started");
} else if (!statSync(socketPath).isSocket()) {
  captureFail(version, "daemon control path is not a Unix-domain socket");
} else {
  await captureExistingSession();
}

async function captureExistingSession() {
  const peer = openJsonRpcPeer({
    command: clientCommand,
    args: ["app-server", "proxy", "--sock", socketPath],
    timeoutMs: 5_000,
  });
  let idle = UNOBSERVED;

  try {
    const initialized = await peer.request("initialize", {
      clientInfo: { name: "acc-native-boundary-spike", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    });
    if (appServerVersion(initialized.userAgent) !== CERTIFIED_VERSION) {
      captureFail(version, "running app-server version did not match codex-cli 0.152.0");
      return;
    }
    peer.notify("initialized", {});

    const listed = await peer.request("thread/list", {
      cwd: options.cwd,
      limit: 100,
      useStateDbOnly: true,
    });
    const target = listed.data?.find((thread) => thread.id === options.thread);
    if (!target || target.status?.type === "notLoaded") {
      captureFail(version, "exact thread was not already reported as running");
      return;
    }
    if (target.status?.type === "active") {
      captureFail(version, "exact thread was active; turn/start was not attempted");
      return;
    }
    if (target.status?.type !== "idle") {
      captureFail(version, "exact thread was not in the certified idle state");
      return;
    }

    const resumed = await peer.request("thread/resume", {
      threadId: options.thread,
      excludeTurns: true,
    });
    if (resumed.thread?.id !== options.thread || resumed.thread?.cwd !== options.cwd) {
      captureFail(version, "thread/resume did not return the exact target and cwd");
      return;
    }
    if (resumed.thread.status?.type !== "idle") {
      captureFail(version, "resumed thread was active; turn/start was not attempted");
      return;
    }

    await peer.request("turn/start", {
      threadId: options.thread,
      input: [],
      clientUserMessageId: options.message,
      turnTrigger: "agents-can-communicate",
      toolOutput: {
        name: "acc_peer_message",
        namespace: "agents-can-communicate",
        output: JSON.stringify({
          messageId: options.message,
          untrusted: true,
          body: "ACC native delivery boundary probe.",
        }),
      },
    });
    idle = "offered";
    captureFail(version,
      "idle offer succeeded; busy, reply, duplicate, and fallback branches remain unobserved",
      { idle });
  } catch (error) {
    const reason = /invalid params|schema|unknown field|missing field/i.test(error.message)
      ? "installed app-server schema rejected the turn/start payload"
      : "app-server proxy request failed before the capture was complete";
    captureFail(version, reason, { idle });
  } finally {
    await peer.close();
  }
}

function captureFail(version, reason, branches = {}) {
  const capture = validateCapture({
    client: CLIENT,
    version: version || "unavailable",
    platform: `${process.platform}-${process.arch}`,
    observedAt: new Date().toISOString(),
    capability: "native_delivery",
    result: "fail",
    fixture: "codex-cli-0.152.0-existing-session",
    launchMode: "no-client-launched",
    protocolContract: "codex-app-server-turn-start-v0",
    idle: branches.idle ?? UNOBSERVED,
    busy: UNOBSERVED,
    reply: UNOBSERVED,
    duplicate: UNOBSERVED,
    fallback: UNOBSERVED,
    limitations: [reason, "no daemon or target client process was started by this capture"],
  });
  process.stdout.write(`${JSON.stringify(capture, null, 2)}\n`);
}

function readVersion(command) {
  const run = spawnSync(command, ["--version"], { encoding: "utf8" });
  return /codex-cli\s+(\S+)/.exec(run.stdout)?.[1] ?? "unavailable";
}

function appServerVersion(userAgent) {
  return /^codex_app_server\/([^\s()]+)(?:\s|$)/.exec(String(userAgent ?? ""))?.[1] ?? null;
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!new Set(["--thread", "--message", "--cwd"]).has(key) || !value) usage();
    parsed[key.slice(2)] = value;
  }
  if (!parsed.thread || !parsed.message || !parsed.cwd || !path.isAbsolute(parsed.cwd)) usage();
  return parsed;
}

function usage() {
  process.stderr.write(
    "usage: codex-existing-session.mjs --thread <exact-id> --message <stable-id> --cwd <absolute-path>\n",
  );
  process.exit(2);
}
