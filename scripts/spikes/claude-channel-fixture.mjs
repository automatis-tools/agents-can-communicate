#!/usr/bin/env node
// Derive the Claude Channel capture fixture from the Channel's observation log.
//
// The log records only event names, ids, and timestamps. Whether the session was
// idle, whether a busy message was presented after the turn, and whether the
// durable receipt stayed queued are facts the operator attests from the
// terminal and from ACC itself; this script accepts those verdicts but only
// applies them when the log agrees, then prints the capture through the closed
// contract. A branch the log cannot support stays "unobserved".
//
// usage: claude-channel-fixture.mjs --observations <path> --version <x.y.z>
//   --platform <id> --fixture <id> --idle-id <messageId> --busy-id <messageId>
//   --busy <queued_after_turn|rejected_busy|unobserved> --fallback <queued|unobserved>
//   [--observed-at <iso>] [--limitation <text>]...

import { readFileSync } from "node:fs";

import { PASSING_LAUNCH_MODE, validateCapture } from "./delivery-capture.mjs";

export const PROTOCOL_CONTRACT = "claude-code-channel-mcp-v1";

export function deriveClaudeCapture({ observations, version, platform, fixture, idleId, busyId,
  busy = "unobserved", fallback = "unobserved", limitations = [], observedAt,
  launchMode = PASSING_LAUNCH_MODE }) {
  const count = (event, messageId) => observations.filter((item) => item.event === event
    && (messageId === undefined || item.messageId === messageId)).length;
  const idle = count("notification_accepted", idleId) === 1 ? "offered" : "unobserved";
  const reply = idle === "offered" && count("reply_routed", idleId) >= 1 ? "routed" : "unobserved";
  const duplicate = idle === "offered" && count("duplicate_suppressed", idleId) >= 1
    ? "same_message_id" : "unobserved";
  const busyAccepted = count("notification_accepted", busyId) === 1;
  const busyBranch = busy === "queued_after_turn" && busyAccepted && count("reply_routed", busyId) >= 1
    ? "queued_after_turn"
    : busy === "rejected_busy" && !busyAccepted && count("envelope_rejected") >= 1
      ? "rejected_busy" : "unobserved";
  const fallbackBranch = fallback === "queued" && count("endpoint_closed") >= 1
    ? "queued" : "unobserved";
  const branches = { idle, busy: busyBranch, reply, duplicate, fallback: fallbackBranch };
  const pass = launchMode === PASSING_LAUNCH_MODE
    && Object.values(branches).every((value) => value !== "unobserved");
  const last = observations.map((item) => item.at).filter(Boolean).sort().at(-1);
  return validateCapture({
    client: "claude-code",
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
      : [`branches derived from the observation log only: ${Object.entries(branches)
        .filter(([, value]) => value === "unobserved").map(([key]) => key).join(", ") || "none"}`],
  });
}

export function readObservations(file) {
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function parseArgs(args) {
  const single = new Map([["--observations", "observations"], ["--version", "version"],
    ["--platform", "platform"], ["--fixture", "fixture"], ["--idle-id", "idleId"],
    ["--busy-id", "busyId"], ["--busy", "busy"], ["--fallback", "fallback"],
    ["--observed-at", "observedAt"]]);
  const parsed = { limitations: [] };
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    if (typeof value !== "string" || value === "") usage();
    if (args[index] === "--limitation") parsed.limitations.push(value);
    else if (single.has(args[index])) parsed[single.get(args[index])] = value;
    else usage();
  }
  for (const key of ["observations", "version", "platform", "fixture", "idleId", "busyId"]) {
    if (parsed[key] === undefined) usage();
  }
  return parsed;
}

function usage() {
  process.stderr.write("usage: claude-channel-fixture.mjs --observations <path> --version <x.y.z> "
    + "--platform <id> --fixture <id> --idle-id <id> --busy-id <id> "
    + "[--busy <queued_after_turn|rejected_busy|unobserved>] [--fallback <queued|unobserved>] "
    + "[--observed-at <iso>] [--limitation <text>]...\n");
  process.exit(2);
}

if (process.argv[1] && import.meta.filename === (await import("node:fs")).realpathSync(process.argv[1])) {
  const options = parseArgs(process.argv.slice(2));
  const capture = deriveClaudeCapture({ ...options,
    observations: readObservations(options.observations) });
  process.stdout.write(`${JSON.stringify(capture, null, 2)}\n`);
}
