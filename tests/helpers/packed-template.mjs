import { cp, mkdir, mkdtemp, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { removeFixture } from "./fixture-cleanup.mjs";
import { runNpm } from "./npm-run.mjs";

const repo = path.resolve(import.meta.dirname, "..", "..");

async function installConsumer(root) {
  const pack = path.join(root, "pack");
  const consumer = path.join(root, "consumer");
  await mkdir(pack, { recursive: true });
  await mkdir(consumer, { recursive: true });
  await writeFile(path.join(consumer, "package.json"),
    '{"name":"packed-v02-consumer","version":"1.0.0","private":true}\n');
  const { stdout } = await runNpm(["pack", "--pack-destination", pack],
    { cwd: repo, env: { ...process.env } });
  const tarball = path.join(pack, stdout.trim().split("\n").at(-1));
  await runNpm(["install", "--offline", "--silent", tarball], { cwd: consumer });
  return tarball;
}

// Owned by scripts/run-tests.mjs, outside the checkout. Never persisted across
// runs: source changes therefore always get a new npm pack and installation.
export async function createPackedTemplate() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-packed-template-")));
  try {
    await installConsumer(root);
    return root;
  } catch (error) {
    await removeFixture(root);
    throw error;
  }
}

export async function preparePackedConsumer(root, { fresh = false } = {}) {
  const template = fresh ? null : process.env.ACC_TEST_PACKED_TEMPLATE;
  // Direct node --test and installation-specific tests retain the fresh path.
  if (!template) return installConsumer(root);
  for (const directory of ["pack", "consumer"]) {
    await cp(path.join(template, directory), path.join(root, directory),
      { recursive: true, verbatimSymlinks: true });
  }
  const archives = (await readdir(path.join(root, "pack"))).filter(name => name.endsWith(".tgz"));
  if (archives.length !== 1) throw new Error("packed template must contain exactly one archive");
  return path.join(root, "pack", archives[0]);
}
