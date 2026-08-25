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

/**
 * What `acc doctor` tells a person.
 *
 * It computed a list of what to run next, put it in the data, and printed a
 * one-line summary - so the command documented as saying "what to run next"
 * said it only to `--json`. There were no tests for this command at all.
 */
async function machine(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-doctor-home-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-doctor-data-")));
  const project = path.join(home, "project");
  const bin = path.join(home, "bin");
  await mkdir(project, { recursive: true });
  await mkdir(bin, { recursive: true });
  t.after(() => Promise.all([home, dataHome]
    .map(dir => rm(dir, { recursive: true, force: true }))));

  // A client of this machine's own, so the test asks the same questions
  // everywhere. Detection spawns the real binary, and CI has none of the four
  // installed - which is how a test about an install comes to prove nothing
  // there while passing on the machine it was written on.
  const claude = path.join(bin, "claude");
  await writeFile(claude, "#!/bin/sh\necho \"2.1.233 (Claude Code)\"\n");
  await chmod(claude, 0o755);

  // Detection spawns the client's binary, and the default three seconds is not
  // always enough while the rest of the suite is running: the stub looked absent
  // and every test here failed on a machine that had it.
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    HOME: home, ACC_DATA_HOME: dataHome, ACC_PROBE_TIMEOUT_MS: "30000",
    GIT_DIR: "", GIT_WORK_TREE: "" };

  // Nothing here asks the registry: the check is switched off, except where a
  // test seeds an answer that is still fresh so none is needed.
  const doctor = async (extra = {}) => (await run(process.execPath,
    [acc, "doctor", "--cwd", project],
    { env: { ...env, ACC_NO_UPDATE_CHECK: "1", ...extra } })).stdout;

  const install = () => run(process.execPath,
    [acc, "install", "--adapter", "claude_code", "--home", home, "--cwd", project], { env });

  const record = path.join(dataHome, "acc", "installs.json");
  // A record written the way the installer writes one, without needing a client
  // on this machine to have been detected first.
  const record4 = async entry => {
    await mkdir(path.dirname(record), { recursive: true });
    await writeFile(record, JSON.stringify({ schemaVersion: 1, installs: [
      { adapterId: entry.adapterId, version: "2.1.233",
        ...(entry.accVersion === undefined ? {} : { accVersion: entry.accVersion }),
        artifacts: [] }] }, null, 2));
  };
  return { home, dataHome, project, doctor, install, record, record4 };
}

test("doctor prints what to run next, not only the summary", async t => {
  const place = await machine(t);
  // Seeded rather than installed: this is about the report reaching the reader,
  // and every adapter is described whether its client is on the machine or not.
  await place.record4({ adapterId: "claude_code", accVersion: "0.0.9" });

  const text = await place.doctor();

  assert.match(text, /store healthy/);
  assert.match(text, /acc install --adapter claude_code/,
    "the remediation was computed and shown only to --json");
});

test("doctor says when a client is wired to an older acc than the one running", async t => {
  const place = await machine(t);
  // What an upgrade leaves behind: `npm install -g` replaces the CLI and the
  // hook runtime, and the bundle written into the client stays where it was.
  await place.record4({ adapterId: "claude_code", accVersion: "0.0.9" });

  assert.match(await place.doctor(),
    /acc install --adapter claude_code {2}# plugin is 0\.0\.9, acc is \d+\.\d+\.\d+/);
});

test("an install records the acc that made it", async t => {
  const place = await machine(t);
  await place.install();

  // Without this the staleness check can never fire on a real machine, and
  // every test around it would go on passing: they write the record themselves.
  const record = JSON.parse(await readFile(place.record, "utf8"));
  const manifest = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8"));

  assert.deepEqual(record.installs.map(install => install.accVersion), [manifest.version]);
  assert.deepEqual(record.installs.map(install => install.adapterId), ["claude_code"]);
});

test("an install with no recorded acc version is not called stale", async t => {
  const place = await machine(t);
  // Installs made before the record carried it. "Your plugin might be old" on
  // every run is not a diagnosis.
  await place.record4({ adapterId: "claude_code", accVersion: undefined });

  assert.doesNotMatch(await place.doctor(), /plugin is/);
});

test("doctor mentions a newer release without asking the registry itself", async t => {
  const place = await machine(t);
  await mkdir(path.join(place.dataHome, "acc"), { recursive: true });
  // A remembered answer that is still fresh, so the check is not due and no
  // call is made. This is what a person sees the day after `acc update`.
  await writeFile(path.join(place.dataHome, "acc", "update-check.json"),
    JSON.stringify({ latest: "99.0.0", checkedAt: "2099-01-01T00:00:00.000Z" }));

  const text = await place.doctor({ ACC_NO_UPDATE_CHECK: "" });

  assert.match(text, /acc update --apply {2}# 99\.0\.0 is on npm, you have \d+\.\d+\.\d+/);
  // And with the switch on, the same machine says nothing about it.
  assert.doesNotMatch(await place.doctor(), /is on npm/);
});
