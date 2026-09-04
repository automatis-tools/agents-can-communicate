#!/usr/bin/env node
// Internal entry point behind an ACC-owned shell shim: is this exact vendor
// executable eligible for native delivery right now? Exit 0 means yes and the
// shim exports its owned policy before `exec`; any other exit - including a
// crash, a missing adapter, or a damaged install - means the shim launches the
// vendor command untouched. Nothing is ever written to stdout, and stderr stays
// empty unless ACC_BOOTSTRAP_DEBUG=1 asks for one safe line.
import { checkNativeBootstrap } from "@agents-can-communicate/installer";

import { createClaudeCodeAdapter } from "@agents-can-communicate/adapter-claude-code";
import { createCodexAdapter } from "@agents-can-communicate/adapter-codex";
import { createGeminiCliAdapter } from "@agents-can-communicate/adapter-gemini-cli";
import { createGrokAdapter } from "@agents-can-communicate/adapter-grok";
import { createKimiAdapter } from "@agents-can-communicate/adapter-kimi";

const FLAGS = new Map([["--adapter", "adapter"], ["--real-executable", "realExecutable"],
  ["--data-home", "dataHome"]]);

function debug(line) {
  if (process.env.ACC_BOOTSTRAP_DEBUG === "1") process.stderr.write(`acc-bootstrap: ${line}\n`);
}

function parse(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = FLAGS.get(args[index]);
    const value = args[index + 1];
    if (key === undefined || typeof value !== "string" || value === "" || key in options) return null;
    options[key] = value;
  }
  return FLAGS.values().every(key => key in options) ? options : null;
}

try {
  const options = parse(process.argv.slice(2));
  if (options === null) {
    debug("usage: --adapter <id> --real-executable <path> --data-home <path>");
    process.exit(2);
  }
  const registry = {
    claude_code: createClaudeCodeAdapter, codex: createCodexAdapter,
    gemini_cli: createGeminiCliAdapter, grok: createGrokAdapter, kimi: createKimiAdapter,
  };
  const adapter = registry[options.adapter]?.();
  if (adapter === undefined) {
    debug(`${options.adapter}: unknown adapter`);
    process.exit(1);
  }
  const result = await checkNativeBootstrap({ adapter, realExecutable: options.realExecutable,
    platform: `${process.platform}-${process.arch}`, dataHome: options.dataHome, timeoutMs: 750 });
  debug(`${options.adapter}: ${result.supported ? "supported" : result.reasonCode}`);
  process.exit(result.supported ? 0 : 1);
} catch (error) {
  debug(`failed: ${String(error?.code ?? error?.name ?? "error")}`);
  process.exit(1);
}
