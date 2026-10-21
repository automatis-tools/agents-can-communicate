import { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSite } from "../website/build.mjs";
let built;
after(async () => { if (built) await rm(await built.catch(() => null), { recursive: true, force: true }); });
export function siteArtifact() {
  return built ??= (async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "acc-website-artifact-"));
    await buildSite({ outDir });
    return outDir;
  })();
}
