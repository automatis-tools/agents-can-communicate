import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
  await mkdir(project, { recursive: true });
  t.after(() => Promise.all([home, dataHome]
    .map(dir => rm(dir, { recursive: true, force: true }))));

  // Nothing here asks the registry: the check is switched off, except where a
  // test seeds an answer that is still fresh so none is needed.
  const doctor = async (extra = {}) => (await run(process.execPath,
    [acc, "doctor", "--cwd", project],
    { env: { ...process.env, HOME: home, ACC_DATA_HOME: dataHome,
      ACC_NO_UPDATE_CHECK: "1", GIT_DIR: "", GIT_WORK_TREE: "", ...extra } })).stdout;

  const install = () => run(process.execPath,
    [acc, "install", "--adapter", "claude_code", "--home", home, "--cwd", project],
    { env: { ...process.env, HOME: home, ACC_DATA_HOME: dataHome,
      GIT_DIR: "", GIT_WORK_TREE: "" } });

  const record = path.join(dataHome, "acc", "installs.json");
  return { home, dataHome, project, doctor, install, record };
}

test("doctor prints what to run next, not only the summary", async t => {
  const place = await machine(t);

  const text = await place.doctor();

  assert.match(text, /store healthy/);
  // A client that is here and not wired up is the whole reason to run this.
  assert.match(text, /acc install --adapter/,
    "the remediation was computed and shown only to --json");
});

test("doctor says when a client is wired to an older acc than the one running", async t => {
  const place = await machine(t);
  await place.install();

  assert.doesNotMatch(await place.doctor(), /plugin is/,
    "reported as stale immediately after being installed");

  // What an upgrade leaves behind: `npm install -g` replaces the CLI and the
  // hook runtime, and the bundle written into the client stays where it was.
  const record = JSON.parse(await readFile(place.record, "utf8"));
  for (const install of record.installs) install.accVersion = "0.0.9";
  await writeFile(place.record, JSON.stringify(record, null, 2));

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
});

test("an install with no recorded acc version is not called stale", async t => {
  const place = await machine(t);
  await place.install();

  // Installs made before the record carried it. "Your plugin might be old" on
  // every run is not a diagnosis.
  const record = JSON.parse(await readFile(place.record, "utf8"));
  for (const install of record.installs) delete install.accVersion;
  await writeFile(place.record, JSON.stringify(record, null, 2));

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
