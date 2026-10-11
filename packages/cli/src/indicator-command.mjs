import { readTomlIndicatorSettings } from "@agents-can-communicate/adapter-sdk";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { readIndicator, indicatorFailure } from "./indicator.mjs";
import { ALL_ADAPTERS } from "./install-command.mjs";

function output(report, options, context) {
  if (options.json) return JSON.stringify(report);
  if (options.details) return [report.label, report.detail, report.action].filter(Boolean).join("\n");
  const extension = context.extension;
  let label = report.label;
  try { label = extension?.renderText?.(report) ?? label; }
  catch { /* A display extension cannot prevent the diagnostic. */ }
  const indicator = label + (report.health === "problem" ? " · acc doctor" : "");
  try {
    if (extension?.composeText) return extension.composeText({ ...context, indicator });
  } catch { /* Keep the diagnostic if the footer cannot be composed. */ }
  return [context.previous, indicator].filter(Boolean).join("\n");
}

async function input(stream) {
  let source = "";
  for await (const chunk of stream) {
    source += chunk;
    if (Buffer.byteLength(source) > 64 * 1024) throw new Error("indicator input too large");
  }
  return source;
}

// The user's existing status command gets exactly the original stdin. The
// installer stores it as data, never as shell text interpolated into ACC's command.
async function previousOutput(previous, payload, timeout) {
  if (previous?.enabled === false || ["builtin", "disabled", "off", "none", "hidden"].includes(previous?.type)
    || typeof previous?.command !== "string" || !previous.command) return "";
  return new Promise(resolve => {
    const child = spawn(previous.command, { shell: true, stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true, timeout });
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
  const options = {}, context = { payload: {}, previous: "", settings: {} };
  let report = indicatorFailure(), timeout;
  try {
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (["--json", "--details"].includes(flag)) options[flag.slice(2)] = true;
      else if (["--adapter", "--native-session", "--previous"].includes(flag)
        && typeof argv[i + 1] === "string") options[flag.slice(2)] = argv[++i];
      else throw new Error("invalid indicator option");
    }
    context.extension = ALL_ADAPTERS().find(adapter => adapter.id === options.adapter)?.statusIndicator;
    const plain = options.json || options.details;
    timeout = setTimeout(() => {
      stdout.write(output(indicatorFailure(), options, context) + "\n", () => process.exit(0));
    }, plain ? 1500 : context.extension?.budgetMs ?? 1500);
    const source = options["native-session"] ? "{}" : await input(stdin);
    context.payload = source.trim() ? JSON.parse(source) : {};
    report = await readIndicator({ adapterId: options.adapter,
      nativeSessionId: options["native-session"] ?? (context.extension?.nativeSessionId
        ? context.extension.nativeSessionId(context.payload)
        : context.payload.conversation_id ?? context.payload.session_id) });
    if (options.previous && !plain) {
      const saved = JSON.parse(await readFile(options.previous, "utf8"));
      context.settings = await readTomlIndicatorSettings(saved);
      context.previous = await previousOutput(saved.previous, source,
        context.extension?.previousTimeoutMs ?? 700);
    }
  } catch { /* A status renderer fails open with an actionable diagnostic. */ }
  finally { clearTimeout(timeout); }
  stdout.write(output(report, options, context) + "\n");
}
