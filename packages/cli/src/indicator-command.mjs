import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { readIndicator, indicatorFailure } from "./indicator.mjs";

async function input(stream) {
  let source = "";
  for await (const chunk of stream) {
    source += chunk;
    if (Buffer.byteLength(source) > 64 * 1024) throw new Error("indicator input too large");
  }
  return source;
}

// The user's existing status command gets exactly the same stdin. Only the
// Antigravity installer supplies this file, from the command it wrapped.
async function previousOutput(file, payload) {
  if (!file) return "";
  const { previous } = JSON.parse(await readFile(file, "utf8"));
  if (previous?.enabled === false || typeof previous?.command !== "string" || !previous.command) return "";
  return new Promise(resolve => {
    const child = spawn(previous.command, { shell: true, stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true, timeout: 700 });
    let text = "";
    child.stdout.on("data", chunk => {
      text += chunk;
      if (Buffer.byteLength(text) > 64 * 1024) child.kill();
    });
    child.stdin.on("error", () => {});
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(text.slice(0, 64 * 1024).trimEnd()));
    child.stdin.end(payload);
  });
}

export async function runIndicator({ argv = process.argv.slice(2), stdin = process.stdin,
  stdout = process.stdout } = {}) {
  const options = {};
  let report = indicatorFailure();
  // Includes a stalled stdin or filesystem, not just time spent awaiting JS.
  const timeout = setTimeout(() => {
    stdout.write(options.json ? JSON.stringify(indicatorFailure()) + "\n" : "ACC ! · acc doctor\n",
      () => process.exit(0));
  }, 1500);
  try {
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (["--json", "--details"].includes(flag)) options[flag.slice(2)] = true;
      else if (["--adapter", "--native-session", "--previous"].includes(flag)
        && typeof argv[i + 1] === "string") options[flag.slice(2)] = argv[++i];
      else throw new Error("invalid indicator option");
    }
    const source = options["native-session"] ? "{}" : await input(stdin);
    const payload = source.trim() ? JSON.parse(source) : {};
    report = await readIndicator({ adapterId: options.adapter,
      nativeSessionId: options["native-session"] ?? payload.conversation_id ?? payload.session_id });
    const previous = await previousOutput(options.previous, source);
    if (previous) stdout.write(previous + "\n");
  } catch { /* A status renderer fails open with a closed, actionable diagnostic. */ }
  finally { clearTimeout(timeout); }
  const text = options.json ? JSON.stringify(report) : options.details
    ? [report.label, report.detail, report.action].filter(Boolean).join("\n")
    : report.label + (report.health === "problem" ? " · acc doctor" : "");
  stdout.write(text + "\n");
}
