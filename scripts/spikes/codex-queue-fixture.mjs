#!/usr/bin/env node
// Derive the Codex queue capture fixture from the probe's closed result lines.
//
// Each case of the capture prints one JSON result (codex-existing-session.mjs);
// ACC itself records the answers and the fallback receipt. The operator attests
// only what neither can measure: that the busy message was presented after the
// running turn. Every verdict is applied only when the recorded results agree,
// and the capture goes through the closed contract.
//
// usage: codex-queue-fixture.mjs --idle <jsonl> --busy <jsonl> --busy-retry <jsonl>
//   --fallback <jsonl> --idle-answer <accMessageId> --busy-answer <accMessageId>
//   --fallback-receipt <queued|unobserved> --busy-after-turn <yes|no>
//   --version <x.y.z> --platform <id> --fixture <id> [--observed-at <iso>]
//   [--limitation <text>]...

import { readFileSync } from "node:fs";

import { PASSING_LAUNCH_MODE, validateCapture } from "./delivery-capture.mjs";

export const PROTOCOL_CONTRACT = "codex-app-server-thread-queue-v1";
const complete = (result) => result?.stage === "complete" && result?.queue?.accepted === true;
const isId = (value) => typeof value === "string" && /^message_[A-Za-z0-9_-]+$/.test(value);

export function deriveCodexCapture({ idle, busy, busyRetry, fallback, idleAnswer, busyAnswer,
  fallbackReceipt = "unobserved", busyAfterTurn = false, version, platform, fixture,
  observedAt, limitations = [], launchMode = PASSING_LAUNCH_MODE }) {
  const idleBranch = complete(idle) && idle.threadStatus === "idle" && idle.queue.duplicate === false
    && isId(idleAnswer) ? "offered" : "unobserved";
  const busyAccepted = complete(busy) && busy.threadStatus === "active" && busy.queue.duplicate === false;
  const busyBranch = busyAccepted && busyAfterTurn && isId(busyAnswer) ? "queued_after_turn"
    : busy?.reasonCode === "recipient_busy" ? "rejected_busy" : "unobserved";
  const reply = idleBranch === "offered" && isId(idleAnswer)
    && (busyBranch !== "queued_after_turn" || isId(busyAnswer)) ? "routed" : "unobserved";
  const duplicate = busyAccepted && complete(busyRetry) && busyRetry.queue.duplicate === true
    && busyRetry.queue.queuedSubmissionId === busy.queue.queuedSubmissionId
    && busyRetry.queue.clientUserMessageId === busy.queue.clientUserMessageId
    ? "same_message_id" : "unobserved";
  const fallbackBranch = fallback?.reasonCode === "transport_unavailable"
    && fallback?.supported === false && fallbackReceipt === "queued" ? "queued" : "unobserved";
  const branches = { idle: idleBranch, busy: busyBranch, reply, duplicate, fallback: fallbackBranch };
  const pass = launchMode === PASSING_LAUNCH_MODE
    && Object.values(branches).every((value) => value !== "unobserved");
  const last = [idle, busy, busyRetry, fallback].map((item) => item?.at).filter(Boolean).sort().at(-1);
  return validateCapture({
    client: "codex-cli",
    version,
    platform,
    observedAt: observedAt ?? last,
    capability: "native_delivery",
    result: pass ? "pass" : "fail",
    fixture,
    launchMode,
    protocolContract: PROTOCOL_CONTRACT,
    ...branches,
    limitations: limitations.length > 0 ? limitations
      : [`branches derived from the recorded results only: ${Object.entries(branches)
        .filter(([, value]) => value === "unobserved").map(([key]) => key).join(", ") || "none"}`],
  });
}

export function readResult(file) {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  return JSON.parse(lines.at(-1));
}

function parseArgs(args) {
  const files = new Map([["--idle", "idle"], ["--busy", "busy"], ["--busy-retry", "busyRetry"],
    ["--fallback", "fallback"]]);
  const single = new Map([["--idle-answer", "idleAnswer"], ["--busy-answer", "busyAnswer"],
    ["--fallback-receipt", "fallbackReceipt"], ["--busy-after-turn", "busyAfterTurn"],
    ["--version", "version"], ["--platform", "platform"], ["--fixture", "fixture"],
    ["--observed-at", "observedAt"]]);
  const parsed = { limitations: [] };
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    if (typeof value !== "string" || value === "") usage();
    if (args[index] === "--limitation") parsed.limitations.push(value);
    else if (files.has(args[index])) parsed[files.get(args[index])] = readResult(value);
    else if (single.has(args[index])) parsed[single.get(args[index])] = value;
    else usage();
  }
  for (const key of ["idle", "busy", "busyRetry", "fallback", "version", "platform", "fixture"]) {
    if (parsed[key] === undefined) usage();
  }
  parsed.busyAfterTurn = parsed.busyAfterTurn === "yes";
  return parsed;
}

function usage() {
  process.stderr.write("usage: codex-queue-fixture.mjs --idle <jsonl> --busy <jsonl> "
    + "--busy-retry <jsonl> --fallback <jsonl> --idle-answer <id> --busy-answer <id> "
    + "--fallback-receipt <queued|unobserved> --busy-after-turn <yes|no> --version <x.y.z> "
    + "--platform <id> --fixture <id> [--observed-at <iso>] [--limitation <text>]...\n");
  process.exit(2);
}

if (process.argv[1] && import.meta.filename === (await import("node:fs")).realpathSync(process.argv[1])) {
  const capture = deriveCodexCapture(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(capture, null, 2)}\n`);
}
