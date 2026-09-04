#!/usr/bin/env node
// Read-only Grok native-delivery capture over the public, vendor-supported
// surface only: `grok --version`, `grok --help`, `grok agent --help`, and
// `grok agent leader --help`. It starts no client, no leader, and no ACP server,
// opens no socket, and reads no transcript. It records what that surface
// exposes for an addressed message into an independently opened ordinary TUI
// session, and prints one capture through the closed contract with a measured
// timestamp. A passing result would require an observed injection path; this
// script cannot produce one, so it only ever reports the honest boundary.

import { spawnSync } from "node:child_process";

import { validateCapture } from "./delivery-capture.mjs";

export const PROTOCOL_CONTRACT = "grok-leader-public-surface-v1";
const VERSION = /^grok\s+(\d+\.\d+\.\d+)(?:\s|$)/;

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.error ? "" : `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

export function inspectGrokSurface({ command = "grok", exec = run } = {}) {
  const version = VERSION.exec(exec(command, ["--version"]).trim())?.[1] ?? "unavailable";
  const tui = exec(command, ["--help"]);
  const agent = exec(command, ["agent", "--help"]);
  const leader = exec(command, ["agent", "leader", "--help"]);
  return Object.freeze({
    version,
    leaderSocketFlag: /--leader-socket/.test(tui) && /--leader-socket/.test(leader),
    leaderClientFlag: /--leader\b/.test(agent) && /--no-leader/.test(agent),
    sharedLeaderMode: /shared leader process/.test(leader) || /shared leader process/.test(agent),
    // No public subcommand or flag names a queue, inject, send, or deliver path
    // into another client's session; the leader help only speaks of sharing one
    // backend and of remote prompts through the vendor relay.
    injectionPath: /\b(inject|queue|deliver|send)[a-z-]*\s+<|--(inject|queue|send|deliver)/
      .test(`${tui}\n${agent}\n${leader}`),
  });
}

export function buildGrokCapture(surface, { platform, observedAt }) {
  const supported = surface.leaderSocketFlag && surface.leaderClientFlag && surface.sharedLeaderMode;
  const limitations = [
    supported
      ? "the public leader surface (--leader, --no-leader, --leader-socket, grok agent leader) "
        + "shares one backend between clients but exposes no addressed message injection into "
        + "an independently opened ordinary TUI session"
      : "the public leader surface was not fully present on this client",
    "the leader socket protocol is private and was not reverse-engineered",
    "grok agent serve and grok agent stdio change launch ownership and are outside the "
      + "transparent-delivery boundary",
    "no Grok client, leader, or ACP server was started by this capture",
    "idle, busy, reply, duplicate, and fallback branches were not observed",
  ];
  return validateCapture({
    client: "grok",
    version: surface.version,
    platform,
    observedAt,
    capability: "native_delivery",
    result: "fail",
    fixture: `grok-${surface.version}-leader`,
    launchMode: "no-client-launched",
    protocolContract: PROTOCOL_CONTRACT,
    idle: "unobserved",
    busy: "unobserved",
    reply: "unobserved",
    duplicate: "unobserved",
    fallback: "unobserved",
    limitations,
  });
}

function main() {
  const command = process.env.ACC_GROK_SPIKE_COMMAND ?? "grok";
  const surface = inspectGrokSurface({ command });
  if (surface.version === "unavailable") {
    process.stderr.write("grok --version did not report a stable version; nothing to capture\n");
    process.exit(1);
  }
  const capture = buildGrokCapture(surface, {
    platform: `${process.platform}-${process.arch}`,
    observedAt: new Date().toISOString(),
  });
  process.stdout.write(`${JSON.stringify(capture, null, 2)}\n`);
}

if (process.argv[1] && import.meta.filename === (await import("node:fs")).realpathSync(process.argv[1])) {
  main();
}
