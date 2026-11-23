#!/usr/bin/env node
// Does a model do the four core ACC tasks from the skill and the hook context
// alone (#135)? Each task is one headless session in an isolated client
// environment (see client-fixture.mjs) with two peers present. The user's prompt
// names the goal and never an ACC command; the result is read back from the ACC
// store, not from what the model says it did.
//
//   node scripts/measure/skill-tasks.mjs --package <acc.tgz> --home <signed-in HOME>
//     --run claude_code=haiku --run claude_code=opus [--repeat 2] [--out run.json]
//
// It spends real tokens: one working session per task, model and repeat.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { openFixture, spawned } from "./client-fixture.mjs";

// A working session: the tools a model needs for these tasks, nothing wider.
const WORKERS = {
  claude_code: {
    binary: "claude",
    // Print mode has nobody to approve a command: allow ACC's CLI, by every path it is installed at.
    args: ({ prompt, model, clis }) => ["-p", prompt, "--output-format", "json", "--strict-mcp-config",
      "--model", model, "--allowedTools", ...clis.flatMap(cli => [`Bash(${cli}:*)`, `Bash("${cli}":*)`]),
      "Read", "Edit", "Write"],
    reply: stdout => JSON.parse(stdout).result ?? "",
    denied: stdout => (JSON.parse(stdout).permission_denials ?? []).map(item => JSON.stringify(item.tool_input)),
  },
  codex: {
    binary: "codex",
    args: ({ prompt, model }) => ["--dangerously-bypass-hook-trust", "-c", "features.remote_plugin=false",
      "-c", "features.apps=false", "-m", model, "exec", "--skip-git-repo-check", "--json", prompt],
    reply: stdout => stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line))
      .filter(event => event.type === "item.completed" && event.item.type === "agent_message")
      .map(event => event.item.text).join("\n"),
  },
  // Kimi's print mode runs in its auto permission mode already. Gemini CLI asks
  // before every command in print mode; yolo lets it act in the throwaway project.
  kimi: {
    binary: "kimi",
    args: ({ prompt, model }) => ["-p", prompt, "--output-format", "stream-json",
      ...(model === "default" ? [] : ["--model", model])],
    // The stream shows hook output as assistant text too; the answer is the last message.
    reply: stdout => stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line))
      .filter(event => event.role === "assistant" && typeof event.content === "string")
      .at(-1)?.content ?? "",
  },
  gemini_cli: {
    binary: "gemini", env: { GEMINI_CLI_TRUST_WORKSPACE: "true" },
    args: ({ prompt, model }) => ["--skip-trust", "-p", prompt, "-o", "json", "--approval-mode", "yolo",
      "-m", model],
    reply: stdout => JSON.parse(stdout.slice(stdout.search(/^\{/m))).response ?? "",
  },
};

const ofMeasured = full => {
  const sessions = new Set(Object.values(full.snapshot.sessions ?? {}).flat()
    .filter(session => session.participantId === "measured").map(session => session.sessionId));
  return { sessions, messages: (full.snapshot.messages ?? []).filter(m => m.fromParticipantId === "measured") };
};

export const TASKS = [
  {
    name: "reply",
    setup: async ({ write, send }) => {
      await write("package.json", '{ "name": "demo", "config": { "port": 7319 } }\n');
      await send("peer-a", ["message", "--to", "measured", "--type", "question", "--subject", "dev port",
        "--body", "Which port does the dev server use? It is in package.json."]);
    },
    prompt: "Check whether another session needs something from you, and deal with it.",
    check: ({ full }) => ofMeasured(full).messages.some(m => m.inReplyTo !== null && /7319/.test(m.body ?? "")),
  },
  {
    name: "read",
    setup: async ({ send }) => send("peer-a", ["message", "--to", "measured", "--type", "note",
      "--subject", "staging database", "--body", "The staging database moved to port 6543 today."]),
    prompt: "Did another session tell you anything about the staging database? Tell me what it said.",
    check: ({ reply }) => /6543/.test(reply),
  },
  {
    name: "claim",
    setup: async ({ write }) => write("src/app.js", "export const answer = 42;\n"),
    prompt: "Another session may edit this repository at the same time. Reserve src/app.js so that "
      + "it knows, then add the line `// checked` at the top of that file.",
    // The claim may be released again once the edit is done; the event stays.
    check: ({ full, edited }) => {
      const { sessions } = ofMeasured(full);
      return edited?.startsWith("// checked") === true && (full.events ?? []).some(event =>
        event.type === "claim.acquired" && sessions.has(event.actorSessionId)
        && ["file:src/app.js", "file:src/**", "file:**"].includes(event.payload?.resource));
    },
  },
  {
    name: "handoff",
    setup: async ({ write }) => write("src/app.js", "export const answer = 42;\n"),
    prompt: "Stop working in this repository now. Hand the remaining work, writing tests for "
      + "src/app.js, over to peer-b through ACC.",
    check: ({ full }) => ofMeasured(full).messages.some(m => m.kind === "handoff"
      && m.toParticipantIds.includes("peer-b") && /test/i.test(JSON.stringify(m))),
  },
];

async function runTask({ id, model, task, tarball, templateHome }) {
  const fixture = await openFixture({ id, tarball, templateHome });
  const { dirs, env } = fixture;
  try {
    await fixture.install();
    const clis = (await readdir(dirs.home, { recursive: true, withFileTypes: true }))
      .filter(entry => entry.name === "acc-cli.sh").map(entry => path.join(entry.parentPath, entry.name));
    // The measured participant exists before its session does, as after any earlier session.
    await fixture.cli(["detach"], await fixture.attach("measured"));
    const peers = { "peer-a": await fixture.attach("peer-a"), "peer-b": await fixture.attach("peer-b") };
    const write = async (relative, text) => {
      const file = path.join(dirs.project, relative);
      await spawned("mkdir", ["-p", path.dirname(file)], { cwd: dirs.project, env });
      await writeFile(file, text);
    };
    await task.setup({ write, send: (from, args) => fixture.cli(args, peers[from]) });
    const started = Date.now();
    const result = await spawned(WORKERS[id].binary, WORKERS[id].args({ prompt: task.prompt, model, clis }),
      { cwd: dirs.project, env: { ...env, ...WORKERS[id].env } });
    const reply = result.code === 0 ? WORKERS[id].reply(result.stdout) : "";
    const full = await fixture.cli(["sync", "--scope", "full"]);
    const edited = await readFile(path.join(dirs.project, "src", "app.js"), "utf8").catch(() => null);
    return { client: id, model, task: task.name, exit: result.code, seconds: Math.round((Date.now() - started) / 1000),
      passed: result.code === 0 && task.check({ full, reply, edited }), reply: reply.slice(-600),
      edited: edited?.startsWith("// checked") ?? null,
      denied: result.code === 0 ? WORKERS[id].denied?.(result.stdout) ?? [] : [],
      error: result.code === 0 ? null : result.stderr.slice(-400),
      events: (full.events ?? []).map(event => event.type).filter(type => !type.startsWith("workspace")) };
  } finally {
    await fixture.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { package: { type: "string" }, home: { type: "string" },
    run: { type: "string", multiple: true }, repeat: { type: "string", default: "1" },
    task: { type: "string", multiple: true }, out: { type: "string" } } });
  const runs = (values.run ?? []).map(pair => pair.split("=", 2));
  if (!values.package || !values.home || runs.length === 0 || runs.some(([id, model]) => !WORKERS[id] || !model)) {
    process.stderr.write(`usage: --package <tgz> --home <dir> --run <${Object.keys(WORKERS).join("|")}>=<model>...\n`);
    process.exit(2);
  }
  const tasks = TASKS.filter(task => values.task === undefined || values.task.includes(task.name));
  const results = [];
  for (const [id, model] of runs) {
    for (const task of tasks) {
      for (let repeat = 0; repeat < Number(values.repeat); repeat += 1) {
        process.stderr.write(`${id} ${model} ${task.name} ${repeat + 1}\n`);
        results.push(await runTask({ id, model, task, tarball: path.resolve(values.package),
          templateHome: path.resolve(values.home) }));
        if (values.out) await writeFile(values.out, `${JSON.stringify({ issue: 135, results }, null, 2)}\n`);
      }
    }
  }
  process.stdout.write(["| Client | Model | Task | Passed | Exit | Seconds |", "|---|---|---|---|---|---|",
    ...results.map(r => `| ${r.client} | ${r.model} | ${r.task} | ${r.passed ? "yes" : "no"} | ${r.exit} | ${r.seconds} |`)]
    .join("\n") + "\n");
}
