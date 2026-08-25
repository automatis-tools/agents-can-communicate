import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { checkDue, checkingIsOff, fetchLatest, isNewer, noticeUpdate }
  from "../src/update-check.mjs";
import { runUpdateCommand, upgradeSteps } from "../src/update-command.mjs";

const io = { readFile, writeFile, mkdir };
const answers = version => async () => ({ ok: true, json: async () => ({ version }) });

async function machine(t) {
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-upd-")));
  t.after(() => rm(dataHome, { recursive: true, force: true }));
  return dataHome;
}

test("a version is newer only when it can be read and is larger", () => {
  assert.equal(isNewer("0.2.0", "0.1.1"), true);
  assert.equal(isNewer("1.0.0", "0.9.9"), true);
  assert.equal(isNewer("0.1.2", "0.1.1"), true);
  assert.equal(isNewer("0.1.1", "0.1.1"), false);
  assert.equal(isNewer("0.1.0", "0.1.1"), false);
  assert.equal(isNewer("0.2.0-beta.1", "0.1.1"), true, "a prerelease of a later version");
  // Telling somebody to upgrade because a version could not be read is worse
  // than saying nothing at all.
  // The case the guard is actually for: a first number that reads, and a rest
  // that does not. Comparing segment by segment would answer "newer" off the
  // leading number alone and send somebody to upgrade to a version that is not
  // a version.
  assert.equal(isNewer("2.x", "1.0.0"), false);
  assert.equal(isNewer("2.0.0", "1.x"), false);
  for (const pair of [["latest", "0.1.1"], ["0.2.0", "unknown"], [null, "0.1.1"],
    ["0.2.0", undefined], ["", ""]]) {
    assert.equal(isNewer(...pair), false, JSON.stringify(pair));
  }
});

test("the answer is remembered for a day", () => {
  const now = Date.parse("2026-08-25T12:00:00.000Z");
  assert.equal(checkDue({ checkedAt: null, now }), true, "never asked");
  assert.equal(checkDue({ checkedAt: "not a date", now }), true);
  assert.equal(checkDue({ checkedAt: "2026-08-25T11:00:00.000Z", now }), false);
  assert.equal(checkDue({ checkedAt: "2026-08-24T11:59:00.000Z", now }), true);
});

test("the switch turns it off, and only the switch", () => {
  assert.equal(checkingIsOff({ ACC_NO_UPDATE_CHECK: "1" }), true);
  assert.equal(checkingIsOff({ ACC_NO_UPDATE_CHECK: "yes" }), true);
  assert.equal(checkingIsOff({ ACC_NO_UPDATE_CHECK: "0" }), false);
  assert.equal(checkingIsOff({ ACC_NO_UPDATE_CHECK: "" }), false);
  assert.equal(checkingIsOff({}), false);
});

test("only a registry answer that carries a version is believed", async () => {
  assert.equal(await fetchLatest({ get: answers("0.3.0") }), "0.3.0");

  await assert.rejects(fetchLatest({ get: async () => ({ ok: false, status: 503 }) }),
    /registry answered 503/);
  await assert.rejects(fetchLatest({ get: async () => ({ ok: true, json: async () => ({}) }) }),
    /did not answer with a version/);
  await assert.rejects(
    fetchLatest({ get: async () => ({ ok: true, json: async () => ({ version: "latest" }) }) }),
    /did not answer with a version/);
});

test("doctor's notice asks at most once a day and never fails the run", async t => {
  const dataHome = await machine(t);
  const now = Date.parse("2026-08-25T12:00:00.000Z");
  let asked = 0;
  const get = async (...argv) => { asked += 1; return answers("0.9.0")(...argv); };

  const first = await noticeUpdate({ dataHome, running: "0.1.1", env: {}, now, get, io });
  assert.deepEqual([first.newer, first.latest, asked], [true, "0.9.0", 1]);

  // Within the day: the remembered answer, and no second call.
  const again = await noticeUpdate({ dataHome, running: "0.1.1", env: {}, now: now + 1000,
    get, io });
  assert.deepEqual([again.newer, asked], [true, 1]);

  // A registry that cannot be reached is not a fault in this machine's install,
  // which is what doctor is about. What was remembered stands.
  const offline = await noticeUpdate({ dataHome, running: "0.1.1", env: {},
    now: now + 2 * 24 * 60 * 60 * 1000,
    get: async () => { throw new Error("getaddrinfo ENOTFOUND"); }, io });
  assert.deepEqual([offline.checked, offline.latest, offline.newer], [true, "0.9.0", true]);
});

test("the switch means nothing is asked, not that nothing is newer", async t => {
  const dataHome = await machine(t);
  let asked = 0;
  const notice = await noticeUpdate({ dataHome, running: "0.1.1",
    env: { ACC_NO_UPDATE_CHECK: "1" }, now: Date.now(),
    get: async () => { asked += 1; return answers("9.9.9")(); }, io });

  assert.deepEqual([notice.checked, notice.newer, asked], [false, false, 0]);
});

const runtimeFor = (dataHome, { version = "0.1.1", latest = "0.1.1", env = {}, spawn } = {}) => ({
  platform: process.platform,
  env: { HOME: dataHome, ACC_DATA_HOME: dataHome, ...env },
  version: async () => version,
  clock: { now: () => "2026-08-25T12:00:00.000Z" },
  fetch: answers(latest),
  spawn,
});

test("`acc update` says what it found, and remembers it", async t => {
  const dataHome = await machine(t);
  const { text, data } = await runUpdateCommand({ options: {},
    runtime: runtimeFor(dataHome, { latest: "0.1.1" }) });

  assert.equal(text, "acc 0.1.1 is the latest");
  assert.equal(data.newer, false);
  assert.match(await readFile(path.join(dataHome, "acc", "update-check.json"), "utf8"),
    /"latest": "0.1.1"/);
});

test("a newer release is reported as two commands, because it is two", async t => {
  const dataHome = await machine(t);
  const { text, data } = await runUpdateCommand({ options: {},
    runtime: runtimeFor(dataHome, { latest: "0.2.0" }) });

  // `npm install -g` replaces the CLI and the hook runtime and leaves the
  // bundle inside each client exactly where it was.
  assert.deepEqual(data.steps, ["npm install --global agents-can-communicate@0.2.0",
    "acc install"]);
  assert.match(text, /acc 0\.2\.0 is available; you have 0\.1\.1/);
  assert.match(text, /acc update --apply/);
});

test("--apply runs both, and says what is left when one fails", async t => {
  const dataHome = await machine(t);
  const ran = [];
  const done = await runUpdateCommand({ options: { apply: true },
    runtime: runtimeFor(dataHome, { latest: "0.2.0",
      spawn: async (command, argv) => { ran.push([command, ...argv].join(" ")); } }) });

  assert.deepEqual(ran, upgradeSteps("0.2.0").map(([one, argv]) => [one, ...argv].join(" ")));
  assert.equal(done.text, "updated to 0.2.0");

  // A global install refused for want of permission is the ordinary failure,
  // and the rest of the work is printed so it can be finished by hand.
  const failed = await runUpdateCommand({ options: { apply: true },
    runtime: runtimeFor(dataHome, { latest: "0.2.0",
      spawn: async () => { throw new Error("EACCES: permission denied"); } }) });

  assert.match(failed.text, /npm failed: EACCES/);
  assert.match(failed.text, /npm install --global agents-can-communicate@0\.2\.0/);
  assert.match(failed.text, /acc install/);
});

test("with the switch on, `acc update` asks nothing at all", async t => {
  const dataHome = await machine(t);
  const { text } = await runUpdateCommand({ options: {},
    runtime: runtimeFor(dataHome, { env: { ACC_NO_UPDATE_CHECK: "1" },
      latest: "9.9.9" }) });

  assert.match(text, /off \(ACC_NO_UPDATE_CHECK\)/);
});
