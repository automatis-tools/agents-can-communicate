import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath,
  writeFile }
  from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { cleanupStack, removeFixture } from "./fixture-cleanup.mjs";
import { fixtureOwnerEnv } from "./fixture-owner.mjs";
import { preparePackedConsumer } from "./packed-template.mjs";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const isWindows = process.platform === "win32";

const parsed = stdout => JSON.parse(stdout).data;

/** A packed fixture installs its own ACC and points it at its own data home,
 * so every ACC_* the caller exported describes their machine rather than this
 * test. ACC_SESSION and ACC_GENERATION are their real credentials, and a
 * policy override such as ACC_NATIVE_DELIVERY_POLICY silently changes the
 * behaviour under test: a leaked one bound a session natively during setup and
 * the turn-lifecycle suite then saw two handshakes where it asserts one.
 * Scrub the inherited namespace, then apply what the fixture sets on purpose.
 * A fixture that wants a value still supplies it through extraEnv.
 */
export function isolatedEnv(inherited, own) {
  const env = { ...inherited };
  for (const key of Object.keys(env)) if (key.startsWith("ACC_")) delete env[key];
  return { ...env, ...own };
}

async function runWithInput(command, args, options, input) {
  const pending = run(command, args, options);
  pending.child.stdin.end(input);
  return pending;
}

export async function treeSnapshot(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const snapshot = [];
  for (const entry of entries) {
    const absolute = path.join(entry.parentPath ?? entry.path, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const stat = await lstat(absolute);
    const mode = stat.mode & 0o7777;
    if (stat.isDirectory()) snapshot.push({ path: relative, type: "directory", mode });
    else if (stat.isFile()) snapshot.push({ path: relative, type: "file", mode,
      bytes: (await readFile(absolute)).toString("base64") });
    else if (stat.isSymbolicLink()) snapshot.push({ path: relative, type: "symlink", mode,
      target: await readlink(absolute) });
    else throw new Error(`unsupported client-home entry type at ${absolute}`);
  }
  return snapshot.sort((left, right) => left.path.localeCompare(right.path));
}

async function writeClientShim(directory, command, output) {
  // A client npm installs on Windows is a `.cmd`; ACC finds it through PATHEXT.
  if (isWindows) {
    if (/[%^&|<>!"]/.test(output)) throw new Error(`cmd cannot echo ${output}`);
    await writeFile(path.join(directory, `${command}.cmd`), `@echo off\r\necho ${output}\r\n`, "utf8");
    return;
  }
  const file = path.join(directory, command);
  const safe = output.replaceAll("'", "'\\''");
  await writeFile(file, `#!/bin/sh\nprintf '%s\\n' '${safe}'\n`, "utf8");
  await chmod(file, 0o755);
}

async function findBinding(dataHome, harnessSessionId) {
  const entries = await readdir(dataHome, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    const value = await readFile(file, "utf8").then(JSON.parse).catch(() => null);
    if (value?.harnessSessionId === harnessSessionId) return value;
  }
  return null;
}

export async function createPackedAcc(t, options = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-v02-packed-")));
  // A test stops what it started in this fixture through `defer`, and those
  // run before the directory is removed; see fixture-cleanup.mjs.
  const defer = cleanupStack(t);
  defer(() => removeFixture(root));
  const pack = path.join(root, "pack");
  const consumer = path.join(root, "consumer");
  const project = path.join(root, "project");
  const dataHome = path.join(root, "data");
  const clientHome = path.join(root, "home");
  const clientBin = path.join(root, "client-bin");
  for (const directory of [pack, consumer, project, dataHome, clientHome, clientBin]) {
    await mkdir(directory, { recursive: true });
  }
  const tarball = await preparePackedConsumer(root, options);

  const installed = path.join(consumer, "node_modules", "agents-can-communicate");
  const accBin = path.join(installed, "bin", "acc.mjs");
  const hookBin = path.join(installed, "bin", "acc-hook.mjs");
  const mcpBin = path.join(installed, "bin", "acc-mcp.mjs");
  const env = isolatedEnv(process.env, { ACC_NO_UPDATE_CHECK: "1", ACC_DATA_HOME: dataHome,
    HOME: clientHome, PATH: clientBin, GIT_DIR: "", GIT_WORK_TREE: "" });

  const commandTrace = [];
  const acc = async (args, extraEnv = {}) => {
    commandTrace.push([...args]);
    return parsed((await run(process.execPath,
    [accBin, ...args, "--cwd", project, "--json"], { cwd: project,
      env: { ...env, ...extraEnv } })).stdout);
  };
  const accError = async (args, extraEnv = {}) => run(process.execPath,
    [accBin, ...args, "--cwd", project, "--json"], { cwd: project,
      env: { ...env, ...extraEnv } }).then(() => null, error => error);
  const hook = async (adapterId, payload, extraEnv = {}) => runWithInput(process.execPath,
    [hookBin, adapterId], { cwd: project, env: { ...env, ...extraEnv } },
    JSON.stringify(payload));

  const setClientVersions = async ({ claude, codex, gemini = "0.0.0",
    grok = "0.0.0", kimi = "0.0.0" }) => {
    await Promise.all([
      writeClientShim(clientBin, "claude", `Claude Code ${claude}`),
      writeClientShim(clientBin, "codex", `codex-cli ${codex}`),
      writeClientShim(clientBin, "gemini", `gemini ${gemini}`),
      writeClientShim(clientBin, "grok", `grok ${grok}`),
      writeClientShim(clientBin, "kimi", `kimi ${kimi}`),
    ]);
  };

  const start = async ({ adapterId, participantId, harnessSessionId }) => {
    const payload = { hook_event_name: "SessionStart", session_id: harnessSessionId,
      cwd: project, source: "startup" };
    await hook(adapterId, payload, { ACC_PARTICIPANT: participantId });
    const status = await acc(["status"]);
    return status.participants.find(item => item.participantId === participantId
      && item.presence !== "offline");
  };

  const beforeTurn = ({ adapterId, harnessSessionId }) => hook(adapterId,
    { hook_event_name: "UserPromptSubmit", session_id: harnessSessionId,
      cwd: project, prompt: "continue" });

  const receipt = async (sessionId, messageId, recipientParticipantId) => {
    const sync = await acc(["sync", "--session", sessionId, "--scope", "full"]);
    return sync.snapshot.receipts.find(item => item.messageId === messageId
      && item.recipientParticipantId === recipientParticipantId);
  };

  const publishBinding = async ({ sessionId, generation, adapterId, clientVersion }) => {
    const packageUrl = name => pathToFileURL(path.join(installed, "node_modules",
      "@agents-can-communicate", name, "src", "index.mjs")).href;
    const urls = { cli: packageUrl("cli"), core: packageUrl("core"),
      protocol: packageUrl("protocol"), storage: packageUrl("storage-filesystem") };
    const source = `
      import { randomBytes } from "node:crypto";
      import { createGitProbe, discoverWorkspace, runtimePaths } from ${JSON.stringify(urls.cli)};
      import { createCoordinationService } from ${JSON.stringify(urls.core)};
      import { createId } from ${JSON.stringify(urls.protocol)};
      import { openFilesystemStore } from ${JSON.stringify(urls.storage)};
      const descriptor = await discoverWorkspace({ cwd: process.env.PROBE_CWD,
        env: { GIT_DIR: "", GIT_WORK_TREE: "" }, gitProbe: createGitProbe() });
      const paths = runtimePaths({ dataHome: process.env.PROBE_DATA,
        workspaceId: descriptor.id, workspaceRoots: descriptor.roots });
      const clock = { now: () => new Date().toISOString() };
      const ids = { next: kind => createId(kind, randomBytes) };
      const store = await openFilesystemStore({ root: paths.root, clock, ids,
        workspaceId: descriptor.id });
      const service = createCoordinationService({ store, clock, ids });
      await service.publishDeliveryBinding({ sessionId: process.env.PROBE_SESSION,
        generation: process.env.PROBE_GENERATION, adapterId: process.env.PROBE_ADAPTER,
        clientVersion: process.env.PROBE_VERSION, availableModes: ["livePush"],
        livePolicy: "actionable", opaqueEndpointRef: "packed-test-endpoint",
        leaseUntil: new Date(Date.now() + 60000).toISOString() });
    `;
    await run(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: consumer, env: { ...env, PROBE_CWD: project, PROBE_DATA: dataHome,
        PROBE_SESSION: sessionId, PROBE_GENERATION: generation,
        PROBE_ADAPTER: adapterId, PROBE_VERSION: clientVersion },
    });
  };

  // An entry point can start ACC's detached runtime worker (#208 reclaim, an
  // update), which outlives the command by design and writes under the data
  // home. A client's hooks do the same at its end: closing a real Claude Code's
  // terminal runs its SessionEnd hook, which records the session's close in the
  // data home while removal walks it, and removal failed with ENOTEMPTY (1 run
  // in 5, 0.9.1 release check). A test whose client ran hooks waits before the
  // directory goes: no manager lock held, and no process working in this
  // fixture, named by its real path or by the /tmp alias of it.
  const workersQuiet = async (timeoutMs = 30_000) => {
    const runtime = path.join(dataHome, "acc", "runtime");
    const locks = [path.join(runtime, "worker", "manager.lock"),
      path.join(runtime, "worker", "poller", "manager.lock")];
    const names = [...new Set([root, root.replace(/^\/private\//, "/")])];
    const running = async () => {
      if (process.platform === "win32") return false;
      const { stdout } = await run("ps", ["-Ao", "args="]).catch(() => ({ stdout: "" }));
      return stdout.split("\n").some(line => names.some(name => line.includes(name)));
    };
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const held = await Promise.all(locks.map(lock => lstat(lock).then(() => true, () => false)));
      if (!held.some(Boolean) && !await running()) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  };

  return { root, defer, repo, pack, consumer, project, dataHome, clientHome, clientBin, workersQuiet,
    tarball, installed, accBin, hookBin, mcpBin, env, acc, accError, commandTrace,
    hook, start, ownerEnv: nativeId => fixtureOwnerEnv(dataHome, nativeId),
    beforeTurn, receipt, setClientVersions, publishBinding,
    manifest: JSON.parse(await readFile(path.join(installed, "package.json"), "utf8")),
    snapshotClientFiles: () => treeSnapshot(clientHome),
    findBinding: harnessSessionId => findBinding(dataHome, harnessSessionId) };
}
