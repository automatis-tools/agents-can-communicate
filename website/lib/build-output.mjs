import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const marker = ".acc-website-build";
const signature = "ACC website output\n";
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);

async function checkDestination(outDir, siteRoot, contentDir) {
  if (outDir === path.parse(outDir).root || within(siteRoot, outDir)
    || within(contentDir, outDir) || within(outDir, contentDir)
    || ["src", "lib", "public"].some(name => within(outDir, path.join(siteRoot, name)))) {
    throw new Error("output must not replace a source directory");
  }
  const info = await lstat(outDir).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("output must be a real directory");
  const entries = await readdir(outDir);
  if (entries.length && await readFile(path.join(outDir, marker), "utf8").catch(() => "") !== signature) {
    throw new Error("refusing to replace an unowned output directory");
  }
  return true;
}

export async function withOutputStage({ outDir, siteRoot, contentDir }, build) {
  await checkDestination(outDir, siteRoot, contentDir);
  await mkdir(path.dirname(outDir), { recursive: true });
  const stage = await mkdtemp(path.join(path.dirname(outDir), ".acc-website-stage-"));
  const previous = stage + "-previous";
  let movedPrevious = false;
  let promoted = false;
  try {
    const result = await build(stage);
    await writeFile(path.join(stage, marker), signature);
    if (await checkDestination(outDir, siteRoot, contentDir)) {
      await rename(outDir, previous);
      movedPrevious = true;
    }
    try {
      await rename(stage, outDir);
      promoted = true;
    } catch (error) {
      if (movedPrevious) {
        try { await rename(previous, outDir); movedPrevious = false; }
        catch { error.message += "; previous output retained at " + previous; }
      }
      throw error;
    }
    return result;
  } finally {
    await rm(stage, { recursive: true, force: true });
    if (promoted && movedPrevious) await rm(previous, { recursive: true, force: true });
  }
}
