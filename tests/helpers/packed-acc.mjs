import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm,
  writeFile }
  from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const isWindows = process.platform === "win32";
const runNpm = (args, options = {}) => (isWindows
  ? run("npm.cmd", args.map(argument => `"${argument}"`), { ...options, shell: true })
  : run("npm", args, options));

const parsed = stdout => JSON.parse(stdout).data;

async function runWithInput(command, args, options, input) {
  const pending = run(command, args, options);
  pending.child.stdin.end(input);
  return pending;
}

async function treeSnapshot(root) {
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
  if (isWindows) return;
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

export async function createPackedAcc(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-v02-packed-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pack = path.join(root, "pack");
  const consumer = path.join(root, "consumer");
  const project = path.join(root, "project");
  const dataHome = path.join(root, "data");
  const clientHome = path.join(root, "home");
  const clientBin = path.join(root, "client-bin");
  for (const directory of [pack, consumer, project, dataHome, clientHome, clientBin]) {
    await mkdir(directory, { recursive: true });
  }
  await writeFile(path.join(consumer, "package.json"),
    '{"name":"packed-v02-consumer","version":"1.0.0","private":true}\n');
  const { stdout } = await runNpm(["pack", "--pack-destination", pack],
    { cwd: repo, env: { ...process.env } });
  const tarball = path.join(pack, stdout.trim().split("\n").at(-1));
  await runNpm(["install", "--offline", "--silent", tarball], { cwd: consumer });

  const installed = path.join(consumer, "node_modules", "agents-can-communicate");
  const accBin = path.join(installed, "bin", "acc.mjs");
  const hookBin = path.join(installed, "bin", "acc-hook.mjs");
  const mcpBin = path.join(installed, "bin", "acc-mcp.mjs");
  const env = { ...process.env, ACC_DATA_HOME: dataHome, HOME: clientHome,
    PATH: clientBin,
    GIT_DIR: "", GIT_WORK_TREE: "" };

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

  return { root, repo, pack, consumer, project, dataHome, clientHome, clientBin,
    tarball, installed, accBin, hookBin, mcpBin, env, acc, accError, commandTrace,
    hook, start,
    beforeTurn, receipt, setClientVersions, publishBinding,
    manifest: JSON.parse(await readFile(path.join(installed, "package.json"), "utf8")),
    snapshotClientFiles: () => treeSnapshot(clientHome),
    findBinding: harnessSessionId => findBinding(dataHome, harnessSessionId) };
}
