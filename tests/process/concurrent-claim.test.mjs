import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { EXIT } from "@agents-can-communicate/protocol";

import { createCoordinationService } from "../../packages/core/src/service.mjs";
import { openFilesystemStore } from "../../packages/storage-filesystem/src/store.mjs";
import { createFakeClock, createFakeIds } from "../helpers/memory-store.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const NOW = "2026-08-16T01:00:00.000Z";
const WORKSPACE = "workspace_a";
const RESOURCE = "file:packages/core/src/claims.mjs";
const CONTENDERS = 4;

const storeModule = new URL("../../packages/storage-filesystem/src/store.mjs", import.meta.url).href;
const serviceModule = new URL("../../packages/core/src/service.mjs", import.meta.url).href;

// Independent processes contending for one exclusive claim. Promise-level
// concurrency would prove nothing here: the writer mutex and the optimistic
// generation check only matter across real process boundaries.
const child = (root, barrier, session) => `
import { openFilesystemStore } from ${JSON.stringify(storeModule)};
import { createCoordinationService } from ${JSON.stringify(serviceModule)};
import { access } from "node:fs/promises";

const clock = { now: () => ${JSON.stringify(NOW)} };
let counter = 0;
const ids = { next: kind => \`\${kind}_${session.label}_\${counter += 1}\` };
const store = await openFilesystemStore({ root: ${JSON.stringify(root)}, clock, ids,
  workspaceId: ${JSON.stringify(WORKSPACE)} });
const service = createCoordinationService({ store, clock, ids });

for (let attempt = 0; attempt < 2000; attempt += 1) {
  try { await access(${JSON.stringify(barrier)}); break; } catch {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

try {
  await service.acquireClaim({ sessionId: ${JSON.stringify(session.sessionId)},
    generation: ${JSON.stringify(session.generation)}, workspaceId: ${JSON.stringify(WORKSPACE)},
    resource: ${JSON.stringify(RESOURCE)}, mode: "exclusive", enforcement: "advisory",
    reason: "editing", leaseSeconds: 1800 });
  process.exit(0);
} catch (error) {
  process.exit(typeof error.code === "number" ? error.code : 1);
}
`;

test("exactly one independent process acquires an exclusive claim", async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-claim-race-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const barrier = path.join(root, "start");

  const store = await openFilesystemStore({ root, clock: createFakeClock(NOW),
    ids: createFakeIds(), workspaceId: WORKSPACE });
  const service = createCoordinationService({ store, clock: createFakeClock(NOW),
    ids: createFakeIds() });
  const sessions = [];
  for (let index = 0; index < CONTENDERS; index += 1) {
    const opened = await service.openSession({ workspaceId: WORKSPACE,
      participantId: `participant_${index}`, displayName: `agent ${index}`,
      harness: "codex", heartbeatCadenceMs: 30_000 });
    sessions.push({ ...opened, label: `c${index}` });
  }

  const runs = sessions.map(session =>
    execFileAsync(process.execPath, ["--input-type=module", "--eval",
      child(root, barrier, session)], { cwd: repoRoot })
      .then(() => 0)
      .catch(error => error.code));
  await writeFile(barrier, "go");
  const codes = await Promise.all(runs);

  const winners = codes.filter(code => code === 0);
  assert.equal(winners.length, 1, `expected one winner, saw ${winners.length} of ${codes}`);
  for (const code of codes.filter(value => value !== 0)) {
    assert.equal(code, EXIT.CONFLICT, `a loser exited ${code} rather than EXIT.CONFLICT`);
  }

  const claims = (await store.snapshot(WORKSPACE)).claims;
  assert.equal(claims.length, 1, "the resource ended up with more than one claim");
  assert.equal(claims[0].resource, RESOURCE);
});
