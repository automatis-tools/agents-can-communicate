import { realpath } from "node:fs/promises";
import path from "node:path";

/** npm's own script, beside this node first. POSIX's `npm` links to it; on
 * Windows that name is a shell script, and node would run it as JavaScript. */
export async function npmCli(env, { platform = process.platform, execPath = process.execPath,
  realpath: resolve = realpath } = {}) {
  const flavour = platform === "win32" ? path.win32 : path.posix;
  // A copy of Windows' environment keeps the variable's own spelling, `Path`.
  const search = Object.entries(env).find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? "";
  const directories = [flavour.dirname(execPath), ...search.split(flavour.delimiter)];
  for (const directory of directories.filter(Boolean)) {
    const candidate = platform === "win32"
      ? flavour.join(directory, "node_modules", "npm", "bin", "npm-cli.js")
      : flavour.join(directory, "npm");
    try { return await resolve(candidate); } catch { /* Try the next installed npm. */ }
  }
  throw new Error("npm is unavailable; the working ACC runtime was kept");
}
