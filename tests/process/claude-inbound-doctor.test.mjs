import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const acc = path.join(repo, "bin", "acc.mjs");

// Claude Code holds every ACC wake for approval in a session that bypasses
// permission prompts, unless its crossSessionInbound setting is accept, and
// drops them when it is refuse. `acc doctor` has to say so to the person who
// turned live delivery on, and name the setting; nobody else needs the line.
async function machine(t, { delivery = "actionable", settings = {} } = {}) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-inbound-home-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-inbound-data-")));
  t.after(() => Promise.all([home, dataHome].map(dir => rm(dir, { recursive: true, force: true }))));
  const project = path.join(home, "project");
  const bin = path.join(home, "bin");
  await mkdir(project, { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(path.join(home, ".claude"), { recursive: true });
  // The version and the inbox marker the probe reads from the binary.
  const claude = path.join(bin, "claude");
  await writeFile(claude, "#!/bin/sh\n# messagingSocketPath\necho \"2.1.283 (Claude Code)\"\n");
  await chmod(claude, 0o755);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: home,
    ACC_DATA_HOME: dataHome, ACC_PROBE_TIMEOUT_MS: "30000", ACC_NO_UPDATE_CHECK: "1",
    CLAUDE_CONFIG_DIR: "", GIT_DIR: "", GIT_WORK_TREE: "" };
  for (const key of Object.keys(env)) if (key.startsWith("ACC_SESSION") || key === "ACC_GENERATION") delete env[key];
  await run(process.execPath, [acc, "install", "--adapter", "claude_code", "--delivery", delivery,
    "--home", home, "--cwd", project], { env });
  const file = path.join(home, ".claude", "settings.json");
  const current = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...current, ...settings }, null, 2));
  const { stdout } = await run(process.execPath, [acc, "doctor", "--cwd", project], { env });
  return { text: stdout, settingsFile: file };
}

const inboundLine = text => text.split("\n").find(line => /Claude Code inbound/.test(line)) ?? null;

test("with live delivery on and no crossSessionInbound, doctor names the setting to accept", async t => {
  const { text, settingsFile } = await machine(t);
  const line = inboundLine(text);
  assert.notEqual(line, null, text);
  assert.match(line, /bypasses permission prompts/);
  assert.match(line, /"crossSessionInbound": "accept"/);
  assert.ok(line.includes(settingsFile), line);
});

test("crossSessionInbound accept leaves nothing to say", async t => {
  const { text } = await machine(t, { settings: { crossSessionInbound: "accept" } });
  assert.equal(inboundLine(text), null, text);
});

test("crossSessionInbound refuse is reported as dropping every wake", async t => {
  const { text } = await machine(t, { settings: { crossSessionInbound: "refuse" } });
  assert.match(inboundLine(text) ?? "", /refuse.*drops every ACC wake/);
});

test("with live delivery off, the inbound setting is not raised", async t => {
  const { text } = await machine(t, { delivery: "off" });
  assert.equal(inboundLine(text), null, text);
});
