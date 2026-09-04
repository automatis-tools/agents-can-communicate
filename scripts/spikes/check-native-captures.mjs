#!/usr/bin/env node
// Stop/go checkpoint for the native-delivery captures.
//
// Reads each named capture through the closed contract and prints one decision
// table - client, result, version, platform, protocol contract - and nothing
// else: no limitations, no bodies. Exit 1 when any *required* capture is
// absent, invalid, or not a pass. An optional capture is printed but never
// decides. Claude Code and Codex are both required by the plan; the caller
// says so explicitly so the decision is visible in the command line.
//
// usage: check-native-captures.mjs --required <client>=<absolute path> ...
//        [--optional <client>=<absolute path> ...]

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { validateCapture } from "./delivery-capture.mjs";

const CLIENT_LABELS = Object.freeze({ claude_code: "Claude Code", codex: "Codex", grok: "Grok" });
const CLIENT_ID = /^[a-z][a-z0-9_]*$/;
const RESULT_WIDTH = 7;

export function decideNativeCaptures({ required, optional = [], readFile = defaultReadFile }) {
  const rows = [
    ...required.map((entry) => ({ ...readCapture(entry, readFile), required: true })),
    ...optional.map((entry) => ({ ...readCapture(entry, readFile), required: false })),
  ];
  const blocking = rows.filter((row) => row.required && row.result !== "pass");
  return { rows, proceed: required.length > 0 && blocking.length === 0,
    blocking: blocking.map((row) => row.client) };
}

function readCapture({ client, file }, readFile) {
  const row = { client, label: CLIENT_LABELS[client] ?? client, result: "absent",
    version: "-", platform: "-", protocolContract: "-" };
  let source;
  try {
    source = readFile(file);
  } catch {
    return row;
  }
  try {
    const capture = validateCapture(JSON.parse(source));
    if (capture.client !== expectedClient(client)) return { ...row, result: "invalid" };
    return { ...row, result: capture.result, version: capture.version,
      platform: capture.platform, protocolContract: capture.protocolContract };
  } catch {
    return { ...row, result: "invalid" };
  }
}

// The fixture names the vendor client; the checkpoint names the adapter id.
function expectedClient(adapterId) {
  return { claude_code: "claude-code", codex: "codex-cli", grok: "grok" }[adapterId]
    ?? adapterId.replaceAll("_", "-");
}

export function renderDecisionTable(rows) {
  const width = Math.max(...rows.map((row) => row.label.length), 4);
  return rows.map((row) => [row.label.padEnd(width), row.result.padEnd(RESULT_WIDTH),
    row.version, row.platform, row.protocolContract].join("  ")).join("\n");
}

function defaultReadFile(file) {
  return readFileSync(file, "utf8");
}

export function parseCheckpointArgs(args) {
  const required = [];
  const optional = [];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    const target = flag === "--required" ? required : flag === "--optional" ? optional : null;
    const separator = typeof value === "string" ? value.indexOf("=") : -1;
    if (target === null || separator <= 0) return null;
    const client = value.slice(0, separator);
    const file = value.slice(separator + 1);
    if (!CLIENT_ID.test(client) || !path.isAbsolute(file)) return null;
    target.push({ client, file });
  }
  if (required.length === 0) return null;
  return { required, optional };
}

function main() {
  const parsed = parseCheckpointArgs(process.argv.slice(2));
  if (parsed === null) {
    process.stderr.write("usage: check-native-captures.mjs --required <client>=<absolute path> "
      + "[--required ...] [--optional <client>=<absolute path> ...]\n");
    process.exit(2);
  }
  const decision = decideNativeCaptures(parsed);
  process.stdout.write(`${renderDecisionTable(decision.rows)}\n`);
  process.exit(decision.proceed ? 0 : 1);
}

const invokedDirectly = typeof process.argv[1] === "string"
  && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === import.meta.filename;
if (invokedDirectly) main();
