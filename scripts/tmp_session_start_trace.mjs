// Measurement only (throwaway branch): the store writes of a first session
// start, a second live session's start in the same workspace, and a turn -
// each flush and rename attributed to its record and the code that made it.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROUNDS = Number(process.argv[2] ?? 3);
const hook = path.resolve("bin/acc-hook.mjs");
const trace = path.resolve("fsync-trace.log");
await writeFile(trace, "");
const preload = pathToFileURL(path.resolve("scripts/tmp_fsync_trace.mjs")).href;
for (let round = 0; round < ROUNDS; round += 1) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-trace-")));
  const project = path.join(base, "project");
  await mkdir(project, { recursive: true });
  const env = { ...process.env, ACC_DATA_HOME: path.join(base, "data"), GIT_DIR: "", GIT_WORK_TREE: "",
    NODE_OPTIONS: `--import=${preload}`, TMP_FSYNC_TRACE: trace };
  const fire = async (label, adapter, payload) => {
    const pending = run(process.execPath, [hook, adapter], { env: { ...env, TMP_FSYNC_LABEL: label } });
    pending.child.stdin.end(JSON.stringify({ cwd: project, ...payload }));
    await pending;
  };
  await fire("first start", "codex", { hook_event_name: "SessionStart", session_id: "first", source: "startup" });
  await fire("second start", "codex", { hook_event_name: "SessionStart", session_id: "second", source: "startup" });
  await fire("turn", "codex", { hook_event_name: "UserPromptSubmit", session_id: "second", prompt: "go" });
  await fire("third start", "codex", { hook_event_name: "SessionStart", session_id: "third", source: "startup" });
}
const kind = file => {
  const name = file.replaceAll("\\", "/");
  for (const [pattern, label] of [[/\/events\//, "event"], [/journal/, "journal"], [/\/sessions?\//, "session"],
    [/bindings/, "binding"], [/participants?/, "participant"], [/intents?/, "intent"], [/claims?/, "claim"],
    [/native-attempts/, "native attempt"], [/pins?\//, "runtime pin"], [/locks?\//, "lock"],
    [/state\.json|\/state\//, "state"], [/stage\//, "stage"], [/workspace/, "workspace"]]) {
    if (pattern.test(name)) return label;
  }
  return name.split("/").slice(-2).join("/");
};
const hooks = (await readFile(trace, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
const byHook = new Map();
for (const item of hooks) { const list = byHook.get(item.hook) ?? []; list.push(item); byHook.set(item.hook, list); }
for (const [label, list] of byHook) {
  const flushes = list.map(item => item.events.filter(event => event.op !== "rename"));
  const renames = list.map(item => item.events.filter(event => event.op === "rename").length);
  const avg = values => Math.round(values.reduce((a, b) => a + b, 0) / values.length * 10) / 10;
  console.log(`\n=== ${label}: ${list.length} runs, flushes ${flushes.map(f => f.length).join("/")}, renames `
    + `${renames.join("/")}, flush ms ${flushes.map(f => Math.round(f.reduce((a, e) => a + e.ms, 0))).join("/")}`);
  const sample = list[0].events;
  const rows = new Map();
  for (const event of sample) {
    const key = `${event.phase} | ${event.op === "rename" ? "rename" : "flush"} | ${kind(event.path)} | ${event.by}`;
    rows.set(key, (rows.get(key) ?? 0) + 1);
  }
  for (const [key, count] of rows) console.log(`${String(count).padStart(3)}  ${key}`);
}
