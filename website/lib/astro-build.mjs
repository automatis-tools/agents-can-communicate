import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
export function runAstro(args, { cwd = root, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "node_modules/astro/bin/astro.mjs"), ...args], {
      cwd, env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1", ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(output) : reject(new Error("Astro " + args[0] + " failed:\n" + output)));
  });
}

// Each invocation owns its source snapshot, validated data and Astro cache.
export async function compileAstro(outDir, articles) {
  const snapshot = await mkdtemp(path.join(tmpdir(), "acc-astro-"));
  try {
    for (const file of ["src", "lib", "public", "astro.config.mjs", "tsconfig.json", "package.json"]) {
      await cp(path.join(root, file), path.join(snapshot, file), { recursive: true });
    }
    await symlink(path.join(root, "node_modules"), path.join(snapshot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const data = path.join(snapshot, "reviewed-content.json");
    await writeFile(data, JSON.stringify(articles));
    const options = { cwd: snapshot, env: { ACC_WEBSITE_DATA: data } };
    await runAstro(["check"], options);
    await runAstro(["build", "--outDir", outDir], options);
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
}
