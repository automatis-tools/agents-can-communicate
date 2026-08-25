import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { writeHookShim } from "../src/hook-shim.mjs";

const run = promisify(execFile);

/**
 * The shim outliving the node that was current when it was written.
 *
 * Its paths are pinned on purpose: a hook runs with an environment that may
 * carry neither PATH nor a shell profile. But the pinned pair moves. A node
 * version manager changes the interpreter *and* the directory global packages
 * live in, and the shim then failed on every event with exit 126 and an empty
 * stdout - no presence, no claims, no messages, and nothing saying why.
 */
async function place(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-shim-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });

  const script = async (name, body) => {
    const file = path.join(bin, name);
    await writeFile(file, `#!/bin/sh\n${body}\n`);
    await chmod(file, 0o755);
    return file;
  };
  const runner = path.join(root, "acc-hook.mjs");
  await writeFile(runner, "// stands in for the runtime\n");

  // Nothing of this machine's own: whatever is on PATH here is what the test
  // put there.
  const fire = (shim, PATH = "/usr/bin:/bin") => run("sh", [shim, "beforeTurn"],
    { env: { PATH } }).catch(error => error);
  return { root, bin, script, runner, fire };
}

test("the pinned pair is what runs while it is there", async t => {
  const here = await place(t);
  const node = await here.script("node", 'echo "ran $*"');
  const shim = await writeHookShim({ dir: here.root, adapterId: "claude_code",
    node, runner: here.runner });

  const { stdout } = await here.fire(shim);

  assert.match(stdout, /ran /);
  assert.match(stdout, new RegExp(here.runner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(stdout, /claude_code/);
  assert.match(stdout, /beforeTurn/, "the client's own arguments were dropped");
});

test("a node that has moved is not the end of it", async t => {
  const here = await place(t);
  const shim = await writeHookShim({ dir: here.root, adapterId: "claude_code",
    node: path.join(here.root, "gone", "node"), runner: here.runner });
  // The interpreter went with the version manager; the runtime is still there,
  // and so is a node.
  const node = await here.script("node", 'echo "current node ran $*"');

  const { stdout } = await here.fire(shim, `${path.dirname(node)}:/usr/bin:/bin`);

  assert.match(stdout, /current node ran/);
  assert.match(stdout, /claude_code beforeTurn/);
});

test("when the package moved too, the binary npm links is asked for", async t => {
  const here = await place(t);
  const shim = await writeHookShim({ dir: here.root, adapterId: "codex",
    node: path.join(here.root, "gone", "node"), runner: here.runner });
  // Switching node versions moves the global directory as well, so the runtime
  // this shim names is gone with it. `acc-hook` is the binary npm links for the
  // package, which is how a reinstall under any node is found.
  await rm(here.runner);
  const linked = await here.script("acc-hook", 'echo "acc-hook ran $*"');
  // Both, because they arrive together: npm links its binaries into the same
  // directory as the node they were installed under.
  await here.script("node", 'echo "the wrong branch ran"');

  const { stdout } = await here.fire(shim, `${path.dirname(linked)}:/usr/bin:/bin`);

  assert.match(stdout, /acc-hook ran codex beforeTurn/);
});

test("with nothing left to run, the turn still goes on", async t => {
  const here = await place(t);
  const missing = path.join(here.root, "gone", "node");
  const shim = await writeHookShim({ dir: here.root, adapterId: "kimi",
    node: missing, runner: here.runner });
  await rm(here.runner);

  const finished = await here.fire(shim);

  // Hooks fail open by design. A broken install is not a reason for somebody's
  // session to stop working - it used to exit 126 and say nothing readable.
  assert.equal(finished.code ?? 0, 0);
  assert.equal(finished.stdout, "", "something was injected by a shim that ran nothing");
  assert.match(finished.stderr, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "the reader is not told which path is missing");
  assert.match(finished.stderr, /acc install/, "the reader is not told what to do");
});

test("a path with a space in it survives being written into a shell script", async t => {
  const here = await place(t);
  const awkward = path.join(here.root, "a directory with spaces");
  await mkdir(awkward, { recursive: true });
  const node = path.join(awkward, "node");
  await writeFile(node, '#!/bin/sh\necho "ran $*"\n');
  await chmod(node, 0o755);

  const shim = await writeHookShim({ dir: here.root, adapterId: "claude_code",
    node, runner: here.runner });

  assert.match((await here.fire(shim)).stdout, /ran /);
});

test("a linked binary that cannot run without node is not run", async t => {
  const here = await place(t);
  const shim = await writeHookShim({ dir: here.root, adapterId: "claude_code",
    node: path.join(here.root, "gone", "node"), runner: here.runner });
  await rm(here.runner);
  // What npm links is a script with `#!/usr/bin/env node`, so without node on
  // PATH it cannot start - and `exec` that fails ends the shim where it stands,
  // taking the line that says what to do with it. Found by installing the
  // tarball and breaking the pinned path: exit 127, `env: node: not found`.
  await here.script("acc-hook", "#!/usr/bin/env node\nconsole.log('never');");

  const finished = await here.fire(shim);

  assert.equal(finished.code ?? 0, 0, "a hook that could not start took the turn with it");
  assert.match(finished.stderr, /acc install/);
});
