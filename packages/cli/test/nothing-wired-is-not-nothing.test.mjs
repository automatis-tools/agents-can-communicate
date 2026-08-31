import assert from "node:assert/strict";
import test from "node:test";

import { describeOutcome } from "../src/install-command.mjs";

/**
 * A machine none of the adapters fit.
 *
 * Every end-to-end run so far was done on a machine carrying every client,
 * so this case was never seen. On a machine with only one - or none - `acc
 * install` says:
 *
 *   installed 0 adapter(s)
 *     skip claude_code: Claude Code is not installed on this machine; …
 *     skip codex: Codex CLI is not installed on this machine; …
 *     skip gemini_cli: …
 *     skip grok: …
 *     skip kimi: …
 *
 * and exits 0. Every line of that is true, and together they read as "ACC has
 * nothing for you". They are wrong about that: the MCP server needs no adapter
 * at all. Measured on exactly such a machine - no client binaries on PATH, a
 * fresh home - `acc-mcp` answered `tools/list` with ten tools and `acc_work`
 * wrote an intent into the store.
 *
 * So the one time it is worth naming is when nothing was wired: a reader who has
 * just been told four times that their machine is not supported.
 */
const skip = id => ({ adapterId: id, reason: `${id} is not installed on this machine` });

test("when nothing was wired, the reader is told what still works", () => {
  const text = describeOutcome({ action: "install", acted: 0,
    skipped: ["claude_code", "codex", "gemini_cli", "grok", "kimi"].map(skip) });

  assert.match(text, /installed 0 adapter\(s\)/);
  assert.match(text, /acc-mcp/,
    `nothing pointed at the path that needs no adapter:\n${text}`);
});

test("wiring even one client makes that advice noise", () => {
  // The skips already name their own remedy. A reader who got an adapter
  // installed is not stuck, and a line that appears every time is a line that
  // stops being read.
  const text = describeOutcome({ action: "install", acted: 1,
    operations: [{ adapterId: "codex", applied: true, changes: [], removed: [] }],
    skipped: ["claude_code", "gemini_cli", "grok", "kimi"].map(skip) });

  assert.doesNotMatch(text, /acc-mcp/);
});

test("an uninstall that removed nothing is not an invitation", () => {
  // Same zero, opposite meaning: this reader is leaving, not arriving.
  const text = describeOutcome({ action: "uninstall", acted: 0,
    skipped: ["claude_code", "codex"].map(skip) });

  assert.doesNotMatch(text, /acc-mcp/);
});

test("the skips are still all there, and still say their own remedy", () => {
  const text = describeOutcome({ action: "install", acted: 0,
    skipped: ["claude_code", "codex", "gemini_cli", "grok", "kimi"].map(skip) });

  for (const id of ["claude_code", "codex", "gemini_cli", "grok", "kimi"]) {
    assert.match(text, new RegExp(`skip ${id}:`));
  }
});
