// Scope arguments require the exact trusted contract, including its imported
// helpers and URL-addressed test preloads. Historical targets run their full gate.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const trustedRoot = path.resolve(import.meta.dirname, "..");
async function contractFiles() {
  const files = new Map();
  const visit = async file => {
    if (files.has(file)) return;
    if (!file.startsWith(`${trustedRoot}${path.sep}`)) throw Error("unsupported selection import");
    const bytes = await readFile(file);
    files.set(file, bytes);
    // These are the trusted modules' static relative imports, not target code.
    const imports = /^\s*(?:import|export)\s+(?:[^;"'`]*?\sfrom\s+)?["'](\.[^"'${}]+\.mjs)["']/gm;
    const urls = /new URL\(["'](\.[^"'${}]+\.mjs)["'],\s*import\.meta\.url\)/g;
    for (const expression of [imports, urls]) {
      for (const match of bytes.toString("utf8").matchAll(expression)) {
        await visit(path.resolve(path.dirname(file), match[1]));
      }
    }
  };
  await visit(path.join(trustedRoot, "scripts/run-tests.mjs"));
  await visit(path.join(trustedRoot, "scripts/verify-package.mjs"));
  return files;
}
let trustedFiles;
export async function supportsSelection(checkout) {
  try {
    const manifest = JSON.parse(await readFile(path.join(checkout, "package.json"), "utf8"));
    if (manifest.scripts?.test !== "node scripts/run-tests.mjs") return false;
    trustedFiles ??= contractFiles();
    for (const [file, trusted] of await trustedFiles) {
      const target = await readFile(path.join(checkout, path.relative(trustedRoot, file)));
      if (!target.equals(trusted)) return false;
    }
    return true;
  } catch { return false; }
}

export async function withSelectionPlan(plan, signal, callback) {
  const owned = await mkdtemp(path.join(tmpdir(), "acc-push-plan-"));
  let retain = false;
  try {
    const file = path.join(owned, "selection.json");
    await writeFile(file, `${JSON.stringify(plan)}\n`, { flag: "wx", mode: 0o600 });
    return await callback(file);
  } catch (error) {
    retain = error.code === "PUSH_TERMINATION_UNCONFIRMED";
    throw error;
  } finally {
    // Match checkout ownership: interruption may leave historical descendants.
    if (retain || signal?.aborted) console.error("pre-push: owned selection plan retained for recovery");
    else await rm(owned, { recursive: true, force: true });
  }
}
