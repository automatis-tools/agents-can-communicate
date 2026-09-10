import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { declaredStoreVersion } from "./activation.mjs";
import { stageOwnGeneration } from "./generation.mjs";
import { verifyGeneration } from "./install.mjs";
import { managedDirectory } from "./state.mjs";
import { ENTRY_KINDS } from "./entry.mjs";

const NAME = "agents-can-communicate";
const exec = promisify(execFile);
export const stableVersion = version => typeof version === "string"
  && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version);
export function newerVersion(candidate, current) {
  if (!stableVersion(candidate) || !stableVersion(current)) return false;
  const left = candidate.split(".").map(BigInt), right = current.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
  return false;
}

/** Metadata only. Downloading and npm run exclusively in the update worker. */
export async function fetchRelease({ pin = null, env = process.env, get = fetch } = {}) {
  if (pin !== null && !stableVersion(pin)) throw new Error("pin must be an exact stable version");
  const registry = new URL(env.npm_config_registry || "https://registry.npmjs.org/");
  if (!["https:", "http:"].includes(registry.protocol)) throw new Error("invalid npm registry");
  registry.pathname = `${registry.pathname.replace(/\/$/, "")}/`;
  const url = new URL(`${NAME}/${pin ?? "latest"}`, registry).href;
  const response = await get(url, { signal: AbortSignal.timeout(5_000), headers: { accept: "application/json" } });
  if (!response?.ok) throw new Error(`registry request failed (${response?.status ?? "no response"})`);
  const body = await response.json();
  if (body?.name !== NAME) throw new Error("release package identity mismatch");
  if (!stableVersion(body.version) || pin !== null && body.version !== pin) throw new Error("release is not the requested stable version");
  const integrity = body.dist?.integrity;
  if (typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)
    || Buffer.from(integrity.slice(7), "base64").length !== 64) throw new Error("release integrity is missing or invalid");
  return { version: body.version, integrity, registry: registry.href };
}

async function npmCli(env) {
  const directories = [path.dirname(process.execPath), ...(env.PATH ?? "").split(path.delimiter)];
  for (const directory of directories.filter(Boolean)) {
    try { return await realpath(path.join(directory, "npm")); } catch { /* Try the next installed npm. */ }
  }
  throw new Error("npm is unavailable; the working ACC runtime was kept");
}

export async function downloadRelease(root, release, { env = process.env } = {}) {
  const downloads = path.join(root, "downloads");
  await managedDirectory(downloads, { create: true });
  const temporary = await mkdtemp(path.join(downloads, ".download-"));
  try {
    await writeFile(path.join(temporary, "package.json"), JSON.stringify({ private: true, name: "acc-runtime-download", version: "1.0.0" }));
    await exec(process.execPath, [await npmCli(env), "install", "--ignore-scripts", "--omit=dev",
      "--global=false", "--prefix", temporary, "--package-lock=true",
      "--package-lock-only=false", "--dry-run=false", "--workspaces=false",
      "--include-workspace-root=false", "--no-audit", "--no-fund", "--save=true", "--save-exact", "--registry", release.registry,
      `${NAME}@${release.version}`], { cwd: temporary, env, timeout: 90_000, maxBuffer: 1024 * 1024 });
    const lock = JSON.parse(await readFile(path.join(temporary, "package-lock.json"), "utf8"));
    if (lock.packages?.[`node_modules/${NAME}`]?.integrity !== release.integrity) {
      throw new Error("downloaded release integrity differs from discovery");
    }
    const packageRoot = path.join(temporary, "node_modules", NAME);
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    if (manifest.name !== NAME || manifest.version !== release.version) throw new Error("downloaded package identity mismatch");
    for (const name of ENTRY_KINDS) await access(path.join(packageRoot, "bin", "entrypoints", `${name}.mjs`));
    await access(path.join(packageRoot, "bin", "acc-update-worker.mjs"));
    const generation = await stageOwnGeneration({ packageRoot, managerRoot: root });
    await verifyGeneration(generation, { env });
    return { version: generation.version, root: generation.root,
      storeVersion: await declaredStoreVersion(generation.root) };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
