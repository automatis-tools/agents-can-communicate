import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "../src/server.mjs";
import { connectMcp } from "../../../tests/helpers/mcp-client.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const execFileAsync = promisify(execFile);
const binary = path.join(repoRoot, "bin", "acc-mcp.mjs");

// A minimal client: writes newline-delimited JSON-RPC to stdin, reads
// newline-delimited JSON-RPC from stdout, keeps stderr separate.
export async function withServer(t, run, { env = {}, reuse } = {}) {
  const workspace = reuse?.workspace
    ?? await realpath(await mkdtemp(path.join(tmpdir(), "acc-mcp-ws-")));
  const dataHome = reuse?.dataHome
    ?? await realpath(await mkdtemp(path.join(tmpdir(), "acc-mcp-home-")));
  if (reuse === undefined) {
    t.after(() => Promise.all([rm(workspace, { recursive: true, force: true }),
      rm(dataHome, { recursive: true, force: true })]));
  }

  const client = connectMcp({ cwd: workspace, dataHome, binary, env });
  const { request, child, closed, stderr } = client;

  const meta = { "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientCapabilities": {} };

  try {
    const attach = participantId => execFileAsync(process.execPath,
      [path.join(repoRoot, "bin", "acc.mjs"), "attach", "--participant", participantId,
        "--harness", "cli", "--cwd", workspace, "--json"],
      { env: { ...process.env, ACC_DATA_HOME: dataHome, GIT_DIR: "", GIT_WORK_TREE: "" } });
    return await run({ request, meta, child, closed, stderr, workspace, attach,
      dataHome });
  } finally {
    await client.close();
  }
}
