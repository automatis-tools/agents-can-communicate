#!/usr/bin/env node
// Compare a baseline and a candidate on one probe (#304), alternating them in
// fresh processes under the same conditions, and record everything that makes
// the comparison repeatable. See docs/design/2026-10-26-comparable-cost-probes.md.
//
//   node scripts/measure/run.mjs --probe attention --set fanout=3 --vary ownRequests=1000,8000 \
//     --baseline v0.12.2 --candidate worktree --rounds 10 --samples 10 --out <dir>
//
// A commit side needs git and tar on PATH and installs with npm.
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { INHERITED } from "../git-provenance.mjs";
import { digest } from "./probe-kit.mjs";
import { classify, renderReport } from "./report.mjs";

const repo = path.resolve(import.meta.dirname, "..", "..");
const { values } = parseArgs({ options: {
  probe: { type: "string" }, set: { type: "string", multiple: true, default: [] },
  vary: { type: "string" }, baseline: { type: "string", default: "worktree" },
  candidate: { type: "string", default: "worktree" }, rounds: { type: "string", default: "10" },
  samples: { type: "string", default: "10" }, warmup: { type: "string", default: "3" },
  fsync: { type: "string", default: "real" }, out: { type: "string" },
  "timeout-ms": { type: "string", default: "900000" }, "candidate-mutation": { type: "string" },
} });
const refuse = message => { process.stderr.write(`${message}\n`); process.exit(2); };
const whole = (key, minimum) => {
  const value = Number(values[key]);
  if (!Number.isSafeInteger(value) || value < minimum) refuse(`--${key} must be a whole number of at least ${minimum}`);
  return value;
};
const settings = { rounds: whole("rounds", 1), samples: whole("samples", 1), warmup: whole("warmup", 0),
  timeoutMs: whole("timeout-ms", 1) };
if (!["real", "skipped"].includes(values.fsync)) refuse("--fsync is real or skipped");
const probe = (await import(new URL(`./probes/${values.probe}.mjs`, import.meta.url))).default;
const literal = text => (/^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text === "true" ? true : text === "false" ? false : text);
const pair = text => { const at = text.indexOf("="); return [text.slice(0, at), text.slice(at + 1)]; };
const base = Object.fromEntries(values.set.map(pair).map(([key, value]) => [key, literal(value)]));
const scenarios = (values.vary ? pair(values.vary)[1].split(",").map(value => ({ ...base, [pair(values.vary)[0]]: literal(value) }))
  : [base]).map(input => probe.scenario(input)).map(scenario => ({ scenario, hash: digest(scenario) }));
// Every call of a child, the observed one included, needs its own fixture record.
const calls = settings.warmup + settings.samples + 1;
for (const { scenario } of scenarios) {
  if (probe.capacity(scenario) < calls) refuse(`${JSON.stringify(scenario)} needs ${calls} calls, and the scenario allows ${probe.capacity(scenario)}`);
}

// A suite or a hook exports GIT_DIR='' and friends; they describe another repository.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !INHERITED.includes(name)));
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: gitEnv }).trim();
// What a side runs: package sources and manifests, the lockfile and the entry points.
const MEASURED = ["packages", "bin", "package.json", "package-lock.json"];
async function sourcesHash(root) {
  const files = [];
  const add = async full => files.push([path.relative(root, full).split(path.sep).join("/"), digest(await readFile(full, "utf8"))]);
  const walk = async directory => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory() && !["node_modules", "test"].includes(entry.name)) await walk(full);
      else if (entry.isFile()) await add(full);
    }
  };
  for (const name of MEASURED) {
    const full = path.join(root, name), info = await stat(full).catch(() => null);
    if (info?.isDirectory()) await walk(full);
    else if (info?.isFile()) await add(full);
  }
  return digest(files);
}
// A commit is exported and installed apart; `worktree` is this checkout as it stands.
async function materialize(label, ref) {
  if (ref === "worktree") {
    return { label, ref, root: repo, commit: git("rev-parse", "HEAD"),
      dirty: git("status", "--porcelain", "--", ...MEASURED).length > 0, sourcesHash: await sourcesHash(repo) };
  }
  const commit = git("rev-parse", "--verify", `${ref}^{commit}`);
  const root = path.join(os.tmpdir(), `acc-measure-${commit}`), ready = path.join(root, ".acc-measure-ready");
  if (!await stat(ready).then(() => true, () => false)) {
    // An interrupted export or install is started again, never reused.
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
    await mkdir(root, { recursive: true });
    const archive = path.join(root, "source.tar");
    execFileSync("git", ["archive", "--format=tar", `--output=${archive}`, commit], { cwd: repo, env: gitEnv, stdio: "inherit" });
    execFileSync("tar", ["-xf", archive, "-C", root], { stdio: "inherit" });
    await rm(archive);
    execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: root, stdio: ["ignore", "ignore", "inherit"],
      shell: process.platform === "win32" });
    await writeFile(ready, `${commit}\n`);
  }
  return { label, ref, root, commit, dirty: false, sourcesHash: await sourcesHash(root) };
}
const sides = { baseline: await materialize("baseline", values.baseline),
  candidate: await materialize("candidate", values.candidate) };

// Durability is set here, never inherited: a local test run preloads the fsync skip.
const skip = pathToFileURL(path.join(repo, "scripts", "test-skip-fsync.mjs")).href;
const nodeOptions = [...(process.env.NODE_OPTIONS ?? "").split(/\s+/).filter(Boolean)]
  .filter((token, index, tokens) => !token.includes("test-skip-fsync") && !(token === "--import" && tokens[index + 1]?.includes("test-skip-fsync")));
if (values.fsync === "skipped") nodeOptions.push("--import", skip);

async function child(sideName, entry) {
  const input = { probe: values.probe, root: sides[sideName].root, scenario: entry.scenario,
    samples: settings.samples, warmup: settings.warmup,
    mutation: sideName === "candidate" ? values["candidate-mutation"] : undefined };
  // Its own temporary directory, removed here: a killed child cleans nothing up itself.
  const scratch = await mkdtemp(path.join(os.tmpdir(), "acc-measure-child-"));
  const loadBefore = os.loadavg(), started = performance.now();
  const ended = fields => ({ loadBefore, loadAfter: os.loadavg(), elapsedMs: Math.round(performance.now() - started), ...fields });
  const outcome = await new Promise(resolve => {
    const process_ = spawn(process.execPath, [path.join(import.meta.dirname, "child.mjs"), JSON.stringify(input)],
      { env: { ...process.env, NODE_OPTIONS: nodeOptions.join(" "), ACC_NO_UPDATE_CHECK: "1",
        TMPDIR: scratch, TEMP: scratch, TMP: scratch }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; process_.kill("SIGKILL"); }, settings.timeoutMs);
    process_.stdout.on("data", chunk => { stdout += chunk; });
    process_.stderr.on("data", chunk => { stderr += chunk; });
    const parsed = () => { try { return JSON.parse(stdout.trim().split("\n").at(-1)); } catch { return null; } };
    const failed = (error, partial = {}) => resolve(ended({ fixtureDigest: null, validation: [], samplesNs: [],
      observations: {}, ...partial, error }));
    // Node ends an uncaught error with its version line, so the cause is further up.
    const tail = () => stderr.trim().split("\n").slice(-20).join("\n");
    process_.on("error", error => { clearTimeout(timer); failed(`${sideName} child did not start: ${error.message}`); });
    // `close`, not `exit`: stdout may still be open when the process has exited.
    process_.on("close", code => {
      clearTimeout(timer);
      const result = parsed();
      if (timedOut) return failed(`${sideName} child timed out after ${settings.timeoutMs} ms`);
      if (result?.error !== undefined) return failed(`${sideName} child failed: ${result.error}`, result);
      if (code !== 0) return failed(`${sideName} child exited ${code}: ${tail()}`, result ?? {});
      if (result === null) return failed(`${sideName} child printed no result: ${tail()}`);
      resolve(ended(result));
    });
  });
  await rm(scratch, { recursive: true, force: true, maxRetries: 5 });
  return outcome;
}

const cpus = os.cpus();
const run = { schemaVersion: 1, probe: values.probe, startedAt: new Date().toISOString(), settings,
  // The harness is what it loads: these scripts and the store I/O probe helper.
  harness: { commit: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "scripts", "tests/helpers").length > 0 },
  host: { node: process.version, v8: process.versions.v8, os: os.type(), release: os.release(), arch: os.arch(),
    cpuModel: cpus[0]?.model ?? "unknown", cores: cpus.length, memoryBytes: os.totalmem() },
  durability: { fsync: values.fsync, nodeOptions: nodeOptions.join(" ") },
  sides: Object.fromEntries(Object.entries(sides).map(([key, { root, ...identity }]) => [key, identity])),
  ...(values["candidate-mutation"] ? { candidateMutation: values["candidate-mutation"] } : {}),
  scenarios, children: [] };
for (let round = 0; round < settings.rounds; round++) {
  const order = round % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
  for (const entry of scenarios) {
    for (const sideName of order) run.children.push({ round, side: sideName, scenarioHash: entry.hash, ...await child(sideName, entry) });
  }
}
run.finishedAt = new Date().toISOString();

const out = values.out ?? await mkdtemp(path.join(os.tmpdir(), `acc-measure-${values.probe}-`));
await mkdir(out, { recursive: true });
await writeFile(path.join(out, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
await writeFile(path.join(out, "report.md"), `${renderReport(run)}\n`);
const labels = classify(run);
for (const { hash, scenario } of scenarios) process.stdout.write(`${labels[hash].label}: ${JSON.stringify(scenario)}\n`);
process.stdout.write(`${path.join(out, "report.md")}\n`);
process.exitCode = Object.values(labels).some(label => label.label === "invalid") ? 1 : 0;
