import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";

// Runtime state lives outside the Workspace, so tests need two disposable
// roots: the Workspace itself and the data home standing in for the platform
// user-data directory. Both are canonicalised because macOS resolves /tmp
// through a symlink, and managed-root containment compares real paths.
export async function withTempWorkspace(run) {
  const created = await mkdtemp(join(tmpdir(), "acc-workspace-"));
  const root = await realpath(created);
  try {
    return await run(root);
  } finally {
    await rm(created, { recursive: true, force: true });
  }
}

export async function withTempRuntime(run) {
  return withTempWorkspace(async root => {
    const created = await mkdtemp(join(tmpdir(), "acc-runtime-"));
    const dataHome = await realpath(created);
    try {
      return await run({ root, dataHome });
    } finally {
      await rm(created, { recursive: true, force: true });
    }
  });
}
