#!/usr/bin/env node
// Read-only bridge for the locally patched Codex footer. No hooks or model calls.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const failure = { health: "problem", reception: null };
async function readReport() {
  let source = "";
  for await (const chunk of process.stdin) {
    source += chunk;
    if (Buffer.byteLength(source) > 8192) throw new Error("Input too large");
  }
  const input = JSON.parse(source);
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input?.thread_id ?? "")) {
    throw new Error("Missing native thread identity");
  }
  const reader = process.argv[2];
  if (!reader) throw new Error("Missing ACC reader");
  const { stdout } = await execute(process.execPath, [reader, "--adapter", "codex",
    "--native-session", input.thread_id, "--json"], { timeout: 400, maxBuffer: 8192 });
  const report = JSON.parse(stdout);
  if (!["ready", "problem"].includes(report?.health)
      || ![null, "automatic", "turn", "inbox"].includes(report?.reception)
      || (report.health === "ready" && report.reception === null)) {
    throw new Error("Invalid indicator report");
  }
  return report;
}

const report = await readReport().catch(() => failure);
const ready = report.health === "ready";
const suffix = (["turn", "inbox"].includes(report.reception) ? ` · ${report.reception}` : "")
  + (ready ? "" : " · acc doctor");
const spans = [{ text: "ACC " },
  { text: ready ? "●" : "!", foreground: ready ? [44, 122, 57] : [150, 108, 30], bold: true }];
if (suffix) spans.push({ text: suffix });
process.stdout.write(`${JSON.stringify({ spans })}\n`);
