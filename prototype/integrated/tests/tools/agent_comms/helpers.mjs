import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createBusPaths,
  ensureBusLayout,
  resolveBusDir,
} from "../../../tools/agents/lib/paths.mjs";

const execFileAsync = promisify(execFile);

// Git exports GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and friends into the
// environment of anything it runs, hooks included. Inheriting them makes every
// fixture operate on the ambient repository instead of its own temporary one,
// so they are stripped unconditionally rather than only when a hook is noticed.
export function hermeticEnv(overrides = {}) {
  const inherited = Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"));
  return { ...Object.fromEntries(inherited), ...overrides };
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd, env: hermeticEnv() });
  return stdout;
}

export async function createGitWorktreeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pw2-agent-git-"));
  const main = path.join(root, "main");
  const worktree = path.join(root, "linked");
  await mkdir(main);
  await git(main, ["init", "--quiet", "--initial-branch=main"]);
  await git(main, ["config", "user.name", "Agent Comms Test"]);
  await git(main, ["config", "user.email", "agent-comms@example.invalid"]);
  await git(main, ["commit", "--quiet", "--allow-empty", "-m", "fixture"]);
  await git(main, ["worktree", "add", "--quiet", "-b", "linked", worktree]);

  const canonicalMain = await realpath(main);
  const canonicalWorktree = await realpath(worktree);
  const bus = path.join(canonicalMain, ".agents");
  return {
    root,
    main: canonicalMain,
    worktree: canonicalWorktree,
    bus,
    resolveFrom: async cwd => resolveBusDir({
      cwd,
      env: {},
      runGit: directory => git(directory, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
    }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export async function createBusFixture() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pw2-agent-bus-"));
  const root = await realpath(temporaryRoot);
  const repo = path.join(root, "repo");
  const bus = path.join(root, ".agents");
  await mkdir(repo);
  const paths = createBusPaths(bus);
  await ensureBusLayout(paths);
  const clock = createFakeClock("2026-08-14T18:00:00.000Z");

  return {
    root,
    repo,
    bus,
    paths,
    clock,
    context: {
      paths,
      now: clock.now,
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export function createFakeClock(startIso) {
  let current = Date.parse(startIso);
  if (!Number.isFinite(current)) throw new TypeError("invalid fake-clock start time");

  return Object.freeze({
    now: () => new Date(current),
    advance: milliseconds => {
      current += milliseconds;
      return new Date(current);
    },
    set: iso => {
      const next = Date.parse(iso);
      if (!Number.isFinite(next)) throw new TypeError("invalid fake-clock time");
      current = next;
      return new Date(current);
    },
  });
}

export async function runCli(fixture, argv, options = {}) {
  const child = startCli(fixture, argv, options);
  if (options.input === undefined) child.stdin.end();
  else child.stdin.end(options.input);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout: child.collected.stdout, stderr: child.collected.stderr };
}

export function startCli(fixture, argv, options = {}) {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url));
  const executable = path.resolve(testDirectory, "../../../tools/agents/comms.mjs");
  const child = spawn(process.execPath, [executable, ...argv], {
    cwd: options.cwd ?? fixture.repo,
    env: hermeticEnv({
      PW2_AGENT_BUS_DIR: fixture.bus,
      ...options.env,
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  Object.defineProperty(child, "collected", { value: { get stdout() { return stdout; },
    get stderr() { return stderr; } } });
  return child;
}

export async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function seedOpenAgent(context, input) {
  const { writeJsonAtomic } = await import("../../../tools/agents/lib/atomic-json.mjs");
  const { validateRegistry } = await import("../../../tools/agents/lib/schema.mjs");
  const now = context.now().toISOString();
  const record = validateRegistry({
    schema_version: 1,
    agent_id: input.agentId,
    role: input.role ?? input.agentId,
    task: input.task ?? "M2.test",
    worktree: input.worktree ?? "/tmp/test-worktree",
    branch: input.branch ?? `test/${input.agentId}`,
    head: input.head ?? "a".repeat(40),
    ownership: input.ownership ?? [],
    status: "open",
    registered_at: input.registeredAt ?? now,
    updated_at: input.updatedAt ?? now,
    ...(input.client === undefined ? {} : { client: input.client }),
  });
  await writeJsonAtomic(context.paths.registryFile(record.agent_id), record, {
    tmpDir: context.paths.tmp,
    exclusive: true,
  });
  return record;
}

export async function seedPresence(context, input) {
  const { writeJsonAtomic } = await import("../../../tools/agents/lib/atomic-json.mjs");
  const { validatePresence } = await import("../../../tools/agents/lib/schema.mjs");
  const record = validatePresence({
    schema_version: 1,
    agent_id: input.agentId,
    pid: input.pid ?? 1234,
    status: input.status ?? "online",
    heartbeat_at: input.heartbeatAt ?? context.now().toISOString(),
  });
  await writeJsonAtomic(context.paths.presenceFile(record.agent_id), record, {
    tmpDir: context.paths.tmp,
    exclusive: false,
  });
  return record;
}

export async function seedMessage(context, input) {
  const { writeJsonAtomic } = await import("../../../tools/agents/lib/atomic-json.mjs");
  const { validateMessage } = await import("../../../tools/agents/lib/schema.mjs");
  const record = validateMessage(input);
  await writeJsonAtomic(context.paths.inboxFile(record.to, record.id), record, {
    tmpDir: context.paths.tmp,
    exclusive: true,
  });
  return record;
}

export function messageUuid(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

export function messageRequest(overrides = {}) {
  return {
    from: "visual",
    to: "models",
    type: "contract_request",
    severity: "action",
    subject: "Need material slots",
    body: "Provide stable hull and turret surface names.",
    task: "M2.7",
    requiresAck: true,
    attachments: [],
    ...overrides,
  };
}

export function replyRequest(messageId, overrides = {}) {
  return {
    from: "models",
    messageId,
    type: "contract_response",
    severity: "info",
    subject: "Material slots",
    body: "Use hull_paper and turret_paper.",
    task: "M2.7",
    attachments: [],
    ...overrides,
  };
}

export function broadcastRequest(overrides = {}) {
  return {
    from: "visual",
    severity: "action",
    subject: "Contract changed",
    body: "Review contract v2.",
    task: "M2.7",
    requiresAck: true,
    attachments: [],
    ...overrides,
  };
}

export async function createMessagingFixture(t, options = {}) {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  let nextUuid = options.uuidStart ?? 1;
  const context = {
    paths: fixture.paths,
    repoRoot: fixture.repo,
    now: fixture.clock.now,
    randomUUID: options.randomUUID ?? (() => messageUuid(nextUuid++)),
    listActiveAgentIds: options.listActiveAgentIds ?? (async () => []),
  };
  const agentIds = options.agentIds ?? ["visual", "models"];
  await Promise.all(agentIds.map(agentId => seedOpenAgent(context, {
    agentId,
    task: "M2.7",
    head: "a".repeat(40),
  })));
  return { ...fixture, context };
}

async function seedReceipt(context, message, kind, overrides) {
  const { writeJsonAtomic } = await import("../../../tools/agents/lib/atomic-json.mjs");
  const schema = await import("../../../tools/agents/lib/schema.mjs");
  const seen = kind === "seen";
  const receipt = (seen ? schema.validateSeenReceipt : schema.validateAcknowledgement)({
    schema_version: 1,
    message_id: message.id,
    recipient: message.to,
    [seen ? "seen_at" : "acknowledged_at"]: context.now().toISOString(),
    ...overrides,
  });
  const filePath = seen
    ? context.paths.seenFile(message.id, message.to)
    : context.paths.ackFile(message.id, message.to);
  await writeJsonAtomic(filePath, receipt, { tmpDir: context.paths.tmp, exclusive: true });
  return receipt;
}

export async function seedSeenReceipt(context, message, overrides = {}) {
  return seedReceipt(context, message, "seen", overrides);
}

export async function seedAcknowledgement(context, message, overrides = {}) {
  return seedReceipt(context, message, "acknowledgement", overrides);
}
