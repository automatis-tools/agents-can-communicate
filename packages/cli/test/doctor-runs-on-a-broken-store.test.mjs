import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { EXIT } from "@agents-can-communicate/protocol";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const binary = path.join(repoRoot, "bin", "acc.mjs");

/**
 * The command you run when the store is broken has to run on a broken store.
 *
 * `runDoctor` already refuses to read records before it has diagnosed them -
 * that was fixed once, after a truncated file made `acc doctor` answer "invalid
 * JSON record" while `inspect` had already found it. But the throw moved rather
 * than went away: every command outside a small list opens the store before its
 * handler is called, and `doctor` was not on that list. So one unreadable
 * `protocol.json` and the diagnosis died in the setup, one stack frame before
 * the code written to report it.
 *
 * Measured: `acc doctor --cwd <broken>` exited 4 with a bare
 * `invalid JSON record: <path>` and nothing else - no list, no framing, no
 * remedy - and `--repair` did the same instead of reporting that repair is
 * blocked, which is what it is designed to say.
 */
async function brokenStore(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-broken-home-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-broken-data-")));
  const project = await realpath(await mkdtemp(path.join(tmpdir(), "acc-broken-proj-")));
  t.after(() => Promise.all([home, dataHome, project]
    .map(dir => rm(dir, { recursive: true, force: true }))));

  const run = (...argv) => execFileAsync(process.execPath, [binary, ...argv],
    { cwd: home, env: { ...process.env, HOME: home, ACC_DATA_HOME: dataHome } })
    .then(({ stdout }) => ({ code: 0, stdout }),
      error => ({ code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }));

  // A workspace, made the way one is made: by asking about it.
  await run("status", "--cwd", project);
  const workspaces = path.join(dataHome, "acc", "workspaces");
  const [id] = await readdir(workspaces);
  const header = path.join(workspaces, id, "protocol.json");
  await writeFile(header, "this is not json\n");
  return { run, project, header };
}

test("doctor diagnoses a store it cannot open", async t => {
  const { run, project, header } = await brokenStore(t);

  const result = await run("doctor", "--cwd", project);

  assert.equal(result.code, EXIT.DATA);
  const said = `${result.stdout}${result.stderr ?? ""}`;
  assert.match(said, new RegExp(header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    `the unreadable file was not named:\n${said}`);
  // The framing is what makes it actionable: this is not "acc is broken", it is
  // "your store cannot be read and repair will not guess".
  assert.match(said, /ambiguous|unreadable/i,
    `no framing beyond the raw parse error:\n${said}`);
});

test("--repair says it is blocked rather than failing the same way", async t => {
  const { run, project } = await brokenStore(t);

  const result = await run("doctor", "--repair", "--cwd", project);
  const said = `${result.stdout}${result.stderr ?? ""}`;

  assert.equal(result.code, EXIT.DATA);
  assert.match(said, /repair is blocked/i,
    `repair failed without saying it refused on purpose:\n${said}`);
});

test("machine mode carries the diagnosis, not just the failure", async t => {
  const { run, project, header } = await brokenStore(t);

  const result = await run("doctor", "--cwd", project, "--json");
  const body = JSON.parse(result.stdout);

  assert.equal(body.ok, false);
  assert.equal(body.error.code, EXIT.DATA);
  assert.equal(JSON.stringify(body.error.details).includes(header), true,
    `the details name no file: ${JSON.stringify(body.error.details)}`);
});

test("a healthy store is still diagnosed the same way", async t => {
  // The fix must not turn doctor into a command that only reports disasters.
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-ok-home-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-ok-data-")));
  const project = await realpath(await mkdtemp(path.join(tmpdir(), "acc-ok-proj-")));
  t.after(() => Promise.all([home, dataHome, project]
    .map(dir => rm(dir, { recursive: true, force: true }))));

  const { stdout } = await execFileAsync(process.execPath,
    [binary, "doctor", "--cwd", project],
    { cwd: home, env: { ...process.env, HOME: home, ACC_DATA_HOME: dataHome } });

  assert.match(stdout, /store healthy/);
});
