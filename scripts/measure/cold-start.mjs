#!/usr/bin/env node
// Measure what one ACC process start costs on each hook path and for `inbox`
// (#150): wall time, and the CPU time of the process and every child it waited
// for. A client runs a hook on every event and a waiting agent polls `inbox`,
// so this is the cost a session pays again and again.
//
//   node scripts/measure/cold-start.mjs [--package <dir>] [--rounds 20] [--warmup 2] [--out run.json]
//
// `--package` is a directory with ACC's `bin/` - the checkout by default, or an
// installed package such as `node_modules/agents-can-communicate`. Each round is
// one Claude Code session in a fresh Git project: start, a prompt, a guarded
// write, an inbox read, a stop and the end, after a bare Node start for scale. Nothing outside a temporary
// directory is read or written, and no network is used.
//
// POSIX only: CPU time comes from the shell's `times`, which counts every
// descendant the measured process waited for. A detached worker it leaves
// behind is not counted.
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** The hook runner's own deadline for one hook (packages/hook-runner). */
export const HOOK_BUDGET_MS = 5_000;
// `node` is Node itself starting and exiting: the part of every path ACC cannot remove.
export const PATHS = ["node", "sessionStart", "beforeTurn", "guard", "inbox", "finish", "sessionEnd"];

/**
 * The second line of `times` is the user and system time of the shell's
 * children. bash prints `0m0.123s`, dash `0m0.123000s`.
 */
export function childCpuMs(timesOutput) {
  const lines = timesOutput.trim().split("\n").filter(line => /\d+m[\d.]+s/.test(line));
  if (lines.length < 2) throw new Error(`times printed no child line: ${JSON.stringify(timesOutput)}`);
  const values = [...lines.at(-1).matchAll(/(\d+)m([\d.]+)s/g)]
    .map(([, minutes, seconds]) => (Number(minutes) * 60 + Number(seconds)) * 1000);
  if (values.length !== 2) throw new Error(`times child line is not user and system: ${lines.at(-1)}`);
  return { userMs: values[0], systemMs: values[1], cpuMs: values[0] + values[1] };
}

export function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

export function summarize(samples) {
  const pick = key => samples.map(sample => sample[key]).sort((a, b) => a - b);
  const stats = values => ({ median: percentile(values, 0.5), p95: percentile(values, 0.95),
    max: values.at(-1) });
  const wall = stats(pick("wallMs"));
  return { samples: samples.length, wallMs: wall, cpuMs: stats(pick("cpuMs")),
    p95ShareOfHookBudget: wall.p95 / HOOK_BUDGET_MS };
}

const round1 = value => Math.round(value * 10) / 10;

export function renderTable(summary) {
  const rows = PATHS.filter(name => summary[name] !== undefined).map(name => {
    const { wallMs, cpuMs, p95ShareOfHookBudget, samples } = summary[name];
    return `| ${name} | ${samples} | ${round1(wallMs.median)} | ${round1(wallMs.p95)} | `
      + `${round1(cpuMs.median)} | ${round1(cpuMs.p95)} | ${Math.round(p95ShareOfHookBudget * 100)}% |`;
  });
  return ["| Path | Samples | Wall median ms | Wall p95 ms | CPU median ms | CPU p95 ms | p95 of 5 s |",
    "|---|---|---|---|---|---|---|", ...rows].join("\n");
}

/** Run one command under `sh`, timing the wall clock here and CPU through `times`. */
export async function measured(command, args, { cwd, env, input }) {
  const script = 'out=$1; shift; "$@" > "$out" 2>&1; status=$?; times; exit $status';
  const output = path.join(cwd, "..", "out.txt");
  const started = process.hrtime.bigint();
  const child = spawn("/bin/sh", ["-c", script, "sh", output, command, ...args],
    { cwd, env, stdio: ["pipe", "pipe", "inherit"] });
  let times = "";
  child.stdout.on("data", chunk => { times += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
    // A command that never reads its input, such as `node -e 0`, can exit
    // before the write; the pipe then fails with EPIPE (a loaded macOS runner,
    // PR #456). Whether it needed the input shows in its exit code and output.
    child.stdin.on("error", error => { if (error.code !== "EPIPE") reject(error); });
    child.stdin.end(input);
  });
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  const printed = await readFile(output, "utf8");
  if (code !== 0) throw new Error(`${path.basename(args[0])} ${args.slice(1).join(" ")} exited ${code}: ${printed}`);
  return { wallMs, ...childCpuMs(times), printed };
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "acc-cold-start-")));
  const dirs = Object.fromEntries(["home", "data", "project", "bin"]
    .map(name => [name, path.join(root, name)]));
  for (const directory of Object.values(dirs)) await mkdir(directory, { recursive: true });
  // The client a hook asks for its version answers at once, as an installed one would.
  await writeFile(path.join(dirs.bin, "claude"), "#!/bin/sh\nprintf 'Claude Code 2.1.300\\n'\n");
  await chmod(path.join(dirs.bin, "claude"), 0o755);
  const git = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const env = { HOME: dirs.home, ACC_DATA_HOME: dirs.data, ACC_NO_UPDATE_CHECK: "1",
    PATH: [dirs.bin, path.dirname(process.execPath), path.dirname(git), "/usr/bin", "/bin"].join(":"),
    LANG: "C", TMPDIR: os.tmpdir() };
  execFileSync(git, ["init", "-q", dirs.project], { env });
  return { root, ...dirs, env };
}

export async function measure({ packageRoot, rounds, warmup }) {
  const accBin = path.join(packageRoot, "bin", "acc.mjs");
  const hookBin = path.join(packageRoot, "bin", "acc-hook.mjs");
  const samples = Object.fromEntries(PATHS.map(name => [name, []]));
  const loadBefore = os.loadavg();
  for (let round = 0; round < warmup + rounds; round += 1) {
    // A fixture of its own for every round, warm-up included: no round reads a
    // store, project or home that an earlier session left behind.
    const f = await fixture();
    try {
      const sessionId = `cold-start-${round}`;
      const options = payload => ({ cwd: f.project, env: f.env,
        input: JSON.stringify({ session_id: sessionId, cwd: f.project, ...payload }) });
      const hook = (event, payload) => measured(process.execPath, [hookBin, "claude_code"],
        options({ hook_event_name: event, ...payload }));
      const taken = {};
      taken.node = await measured(process.execPath, ["-e", "0"], { cwd: f.project, env: f.env });
      taken.sessionStart = await hook("SessionStart", { source: "startup" });
      taken.beforeTurn = await hook("UserPromptSubmit", { prompt: "continue" });
      const owner = taken.beforeTurn.printed.match(/--session (\S+) --generation (\S+)/);
      if (owner === null) throw new Error(`the prompt hook named no owner: ${taken.beforeTurn.printed}`);
      taken.guard = await hook("PreToolUse", { tool_name: "Write",
        tool_input: { file_path: path.join(f.project, "a.txt"), content: "x" } });
      // Nobody holds a claim, so a guard that denies did other work than the one measured.
      if (/deny/i.test(taken.guard.printed)) throw new Error(`the guard denied: ${taken.guard.printed}`);
      taken.inbox = await measured(process.execPath, [accBin, "inbox", "--session", owner[1],
        "--generation", owner[2], "--cwd", f.project, "--json"], { cwd: f.project, env: f.env });
      if (JSON.parse(taken.inbox.printed).ok !== true) throw new Error(`inbox failed: ${taken.inbox.printed}`);
      taken.finish = await hook("Stop", { stop_hook_active: false });
      taken.sessionEnd = await hook("SessionEnd", { reason: "exit" });
      if (round < warmup) continue;
      for (const name of PATHS) {
        const { wallMs, userMs, systemMs, cpuMs } = taken[name];
        samples[name].push({ wallMs, userMs, systemMs, cpuMs });
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
  return {
    issue: 150, hookBudgetMs: HOOK_BUDGET_MS, rounds, warmup,
    package: { root: packageRoot,
      version: JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")).version },
    machine: { platform: process.platform, arch: process.arch, node: process.version,
      cpu: os.cpus()[0]?.model ?? null, cpus: os.cpus().length, loadBefore, loadAfter: os.loadavg() },
    summary: Object.fromEntries(PATHS.map(name => [name, summarize(samples[name])])),
    samples,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.platform === "win32") {
    process.stderr.write("cold-start measurement needs a POSIX shell for CPU time\n");
    process.exit(2);
  }
  const { values } = parseArgs({ options: {
    package: { type: "string", default: path.resolve(import.meta.dirname, "..", "..") },
    rounds: { type: "string", default: "20" }, warmup: { type: "string", default: "2" },
    out: { type: "string" },
  } });
  const whole = (key, minimum) => {
    const value = Number(values[key]);
    if (!Number.isSafeInteger(value) || value < minimum) {
      process.stderr.write(`--${key} must be a whole number of at least ${minimum}\n`);
      process.exit(2);
    }
    return value;
  };
  const run = await measure({ packageRoot: path.resolve(values.package),
    rounds: whole("rounds", 1), warmup: whole("warmup", 0) });
  if (values.out !== undefined) await writeFile(values.out, `${JSON.stringify(run, null, 2)}\n`);
  process.stdout.write(`ACC ${run.package.version}, Node ${run.machine.node}, ${run.machine.platform} `
    + `${run.machine.arch}, load ${run.machine.loadBefore.map(round1).join("/")}\n\n`
    + `${renderTable(run.summary)}\n`);
}
