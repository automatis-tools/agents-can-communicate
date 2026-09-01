import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Readable, Writable } from "node:stream";
import test, { after } from "node:test";

import { createFakeClock, createFakeIds, createMemoryStore } from "../helpers/memory-store.mjs";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "acc-packed-surface-"));
after(() => rm(temporary, { recursive: true, force: true }));

async function packedTextFiles(root) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...await packedTextFiles(target));
    else if (entry.name === "README.md" || target.includes(`${path.sep}skills${path.sep}`)) {
      found.push(await readFile(target, "utf8"));
    }
  }
  return found;
}

async function listMcpSurface(serve, protocolVersion) {
  const meta = { "io.modelcontextprotocol/protocolVersion": protocolVersion,
    "io.modelcontextprotocol/clientCapabilities": {} };
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } },
    { jsonrpc: "2.0", id: 2, method: "resources/list", params: { _meta: meta } },
  ];
  let output = "";
  await serve({ input: Readable.from(requests.map(value => `${JSON.stringify(value)}\n`)),
    output: new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } }),
    context: {}, log: () => {} });
  const responses = output.trim().split("\n").map(line => JSON.parse(line));
  return { text: output,
    tools: responses.find(response => response.id === 1).result.tools.map(tool => tool.name),
    resources: responses.find(response => response.id === 2).result.resources
      .map(resource => resource.uri) };
}

async function loadPackedSurface() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const { stdout } = await run(npm, ["pack", "--json", "--cache",
    path.join(temporary, "npm-cache"), "--pack-destination", temporary],
    { cwd: repo, maxBuffer: 10 * 1024 * 1024 });
  const [{ filename }] = JSON.parse(stdout);
  await run("tar", ["-xzf", path.join(temporary, filename), "-C", temporary]);

  const packageRoot = path.join(temporary, "package");
  const modules = path.join(packageRoot, "node_modules", "@agents-can-communicate");
  const cli = await import(pathToFileURL(path.join(modules, "cli", "src", "index.mjs")));
  const help = await import(pathToFileURL(path.join(modules, "cli", "src", "help.mjs")));
  const core = await import(pathToFileURL(path.join(modules, "core", "src", "index.mjs")));
  const mcp = await import(pathToFileURL(path.join(modules, "mcp-server", "src", "server.mjs")));
  const resources = await import(pathToFileURL(
    path.join(modules, "mcp-server", "src", "resources.mjs")));
  const clock = createFakeClock("2026-09-01T00:00:00.000Z");
  const service = core.createCoordinationService({
    store: createMemoryStore({ clock, ids: createFakeIds(), workspaceId: "workspace_a" }),
    clock,
    ids: createFakeIds(),
  });
  const mcpSurface = await listMcpSurface(mcp.serve, mcp.PROTOCOL_VERSION);
  const status = await service.collectStatus({ workspaceId: "workspace_a" });
  const sync = await service.sync({ workspaceId: "workspace_a", scope: "full" });
  const resourceSnapshot = await resources.readResource("acc://snapshot", {
    service, participantId: "participant_a", workspaceId: "workspace_a" });
  const text = [help.helpText(), mcpSurface.text,
    ...await packedTextFiles(packageRoot)].join("\n");
  return { commands: cli.COMMANDS, mcpSurface, resourceSnapshot, service, status, sync, text };
}

const packed = await loadPackedSurface();

test("packed public commands are communication and lifecycle only", () => {
  assert.deepEqual(Object.keys(packed.commands).sort(), ["ack", "attach", "claim", "config",
    "detach", "doctor", "finish", "heartbeat", "help", "inbox", "install", "message",
    "release", "reply", "request", "status", "sync", "uninstall", "update", "version",
    "work"]);
});

test("packed MCP tools are communication only", () => {
  assert.deepEqual(packed.mcpSurface.tools.sort(), ["acc_ack", "acc_claim", "acc_finish",
    "acc_inbox", "acc_message", "acc_release", "acc_reply", "acc_request", "acc_status",
    "acc_sync", "acc_work"]);
});

for (const token of ["acc task", "acc workstream", "acc decide", "acc_task",
  "acc_workstream", "acc_decide", "acc://tasks", "acc://workstreams"]) {
  test(`packed artifact omits ${token}`, () => {
    assert.equal(packed.text.includes(token), false, `packed artifact exposes ${token}`);
  });
}

for (const command of ["task", "workstream", "decide"]) {
  test(`public CLI omits ${command}`, () => {
    assert.equal(Object.hasOwn(packed.commands, command), false, `public CLI exposes ${command}`);
  });
}

for (const operation of ["createTask", "createWorkstream", "recordDecision"]) {
  test(`packed service omits ${operation}`, () => {
    assert.equal(Object.hasOwn(packed.service, operation), false,
      `packed service exposes ${operation}`);
  });
}

function assertNoOrchestration(value) {
  for (const field of ["workstreams", "tasks", "decisions"]) {
    assert.equal(Object.hasOwn(value, field), false, `public output exposes ${field}`);
  }
}

test("packed status omits legacy orchestration", () => {
  assertNoOrchestration(packed.status);
  assert.equal(Object.hasOwn(packed.status.counts, "tasks"), false,
    "public status exposes a task count");
});

test("packed full sync omits legacy orchestration", () => {
  assertNoOrchestration(packed.sync.snapshot);
});

test("packed snapshot resource omits legacy orchestration", () => {
  assertNoOrchestration(packed.resourceSnapshot);
});
