// Keep filesystem discovery identical to the full runner, including untracked tests.
import { readdir } from "node:fs/promises";
import path from "node:path";

export async function discoverTestFiles(repo) {
  async function collect(root) {
    const found = [];
    const walk = async directory => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith(".test.mjs")) found.push(full);
      }
    };
    await walk(path.join(repo, root));
    return found;
  }
  return (await Promise.all(["tests", "packages"].map(collect))).flat().sort();
}

// Git tree discovery uses relative POSIX paths, independent of the host platform.
export function discoverTreeTests(entries) {
  // Gitlinks name directories whose nested files are absent from this tree.
  if (entries.some(entry => entry.type !== "blob")) throw Error("target-discovery-unavailable");
  return entries.map(entry => entry.path).filter(file => /^(tests|packages)\//.test(file)
    && file.endsWith(".test.mjs") && !file.split("/").some(part => ["node_modules", ".git"].includes(part))).sort();
}
