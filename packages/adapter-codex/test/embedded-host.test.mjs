import assert from "node:assert/strict";
import test from "node:test";

import { embeddingOption } from "../src/embedded-host.mjs";

// Codex 0.159.1 runs a chat on its own embedded app server, even while the
// daemon runs, when it starts with one of these options ("Running without the
// shared background server: <reason> requires embedded mode.").
test("the option that keeps a Codex chat embedded is named as it was typed", () => {
  for (const [argv, option] of [
    [["codex", "--search"], "--search"],
    [["codex", "-c", "model_reasoning_effort=low"], "-c"],
    [["codex", "--config", "model=\"o3\""], "--config"],
    [["codex", "--config=model=o3"], "--config"],
    [["codex", "-cmodel=o3"], "-c"],
    [["codex", "--enable", "unified_exec"], "--enable"],
    [["codex", "--disable=unified_exec"], "--disable"],
    [["codex", "-p", "work"], "-p"],
    [["codex", "--profile", "work"], "--profile"],
    [["codex", "-pwork"], "-p"],
    [["codex", "--oss"], "--oss"],
    [["codex", "--strict-config"], "--strict-config"],
    [["codex", "--dangerously-bypass-hook-trust"], "--dangerously-bypass-hook-trust"],
    [["codex", "--no-daemon"], "--no-daemon"],
    [["/opt/codex/bin/codex", "-m", "gpt", "--search", "fix", "it"], "--search"],
    [["codex", "resume", "--last", "--search"], "--search"],
    [["codex", "fork", "-c", "x=1"], "-c"],
    [["node", "--no-warnings", "/opt/codex/bin/codex.js", "--no-daemon"], "--no-daemon"],
    // The first one on the command line is the one named.
    [["codex", "--profile", "work", "--search"], "--profile"],
  ]) {
    assert.equal(embeddingOption(argv), option, argv.join(" "));
  }
});

test("a command line without such an option names none", () => {
  for (const argv of [["codex"], ["codex", "-m", "gpt-5"], ["codex", "resume", "--last"],
    // A value is not an option, even when it reads like one.
    ["codex", "-m", "--search"], ["codex", "-C", "--oss"],
    // Words after the prompt starts are the prompt: `ps` drops the quotes.
    ["codex", "fix", "the", "--search", "flag"], ["codex", "resume", "0199a", "--oss"],
    // `--` ends the options: what follows is the prompt, however it reads.
    ["codex", "--", "--search", "is", "broken"], ["codex", "-m", "gpt", "--", "--oss"],
    ["codex", "--searching"], ["codex", "exec", "--search", "task"],
    ["/usr/bin/python3", "codex", "--search"], []]) {
    assert.equal(embeddingOption(argv), null, argv.join(" "));
  }
});

test("a Windows command line names Codex by its image, in any case and with either separator", () => {
  assert.equal(embeddingOption(["C:\\Users\\dana\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
    "--search"]), "--search");
  assert.equal(embeddingOption(["C:/Tools/CODEX.EXE", "-c", "model=o3"]), "-c");
  assert.equal(embeddingOption(["C:\\Program Files\\nodejs\\node.exe",
    "C:\\Users\\dana\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js", "--search"]),
  "--search");
});
