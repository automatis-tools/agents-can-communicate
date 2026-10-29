import { cp, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixedClock, openInstance, WORKSPACE } from "../../scripts/measure/store-fixture.mjs";
import { readActiveJournal } from "../../packages/storage-filesystem/src/active-journal.mjs";

const remove = root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

async function assertQuiescent(root) {
  for (const entry of await readdir(path.join(root, "locks"), { withFileTypes: true })) {
    // These are persistent maintenance bookkeeping, not writer ownership.
    if (entry.isFile() && ["stage-sweep.json", "retention.json"].includes(entry.name)) continue;
    // Windows may leave the canonical lock directory empty after releasing it.
    if (entry.name === "writer.lock" && entry.isDirectory()
      && (await readdir(path.join(root, "locks", entry.name))).length === 0) continue;
    throw new Error("probe fixture fork requires a quiescent seed");
  }
  const journal = await readActiveJournal({ root, journal: path.join(root, "journal") }, root);
  if (journal.state !== "idle") throw new Error("probe fixture fork requires a quiescent seed: open journal");
}

/** Copy a completed, privately owned fixture; never reuse its handles or closures. */
async function forkStoreFixture(side, seed) {
  await assertQuiescent(seed.root);
  const allocated = await mkdtemp(path.join(tmpdir(), "acc-probe-fork-"));
  try {
    const root = await realpath(allocated);
    await cp(seed.root, root, { recursive: true });
    const fixture = { root, clock: fixedClock(seed.clock.now()), ids: seed.ids.fork(),
      sessions: structuredClone(seed.sessions) };
    Object.assign(fixture, await openInstance(fixture, side));
    fixture.owner = participant => ({ workspaceId: WORKSPACE,
      sessionId: fixture.sessions[participant].sessionId, generation: fixture.sessions[participant].generation });
    fixture.dispose = () => remove(root);
    return fixture;
  } catch (error) {
    await remove(allocated);
    throw error;
  }
}

export async function forkInboxFixture(seed) {
  if (seed.next !== 0 || seed.target !== null || Object.hasOwn(seed, "generations")) {
    throw new Error("inbox fixture fork requires an unused seed");
  }
  const { fixture, side: sourceSide, ...data } = seed;
  const copy = structuredClone(data);
  const side = { ...sourceSide };
  return { ...copy, side, fixture: await forkStoreFixture(side, fixture) };
}
