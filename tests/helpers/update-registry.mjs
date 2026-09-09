import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);

/** Two actual ACC archives; only the candidate's package versions are changed. */
export async function createUpdateRegistry(t, fixture, version = null) {
  const candidate = path.join(fixture.root, "candidate-source");
  const archiveDir = path.join(fixture.root, "candidate-archive");
  await cp(fixture.installed, candidate, { recursive: true });
  await mkdir(archiveDir);
  const rootManifest = JSON.parse(await readFile(path.join(candidate, "package.json"), "utf8"));
  const [major, minor, patch] = rootManifest.version.split(".");
  version ??= `${major}.${minor}.${Number.parseInt(patch, 10) + 1}`;
  for (const name of [null, ...rootManifest.bundleDependencies]) {
    const file = path.join(candidate, ...(name === null ? [] : ["node_modules", name]), "package.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...manifest, version }, null, 2) + "\n");
  }
  const { stdout } = await run("npm", ["pack", "--pack-destination", archiveDir], { cwd: candidate });
  const tarball = path.join(archiveDir, stdout.trim().split("\n").at(-1));
  const bytes = await readFile(tarball);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const requests = [];
  let available = true;
  let discoveryIntegrity = null;
  let base;
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (!available) { res.writeHead(503); res.end("fixture unavailable"); return; }
    if (req.url.includes(".tgz")) { res.setHeader("content-type", "application/octet-stream"); res.end(bytes); return; }
    const release = { ...rootManifest, version,
      dist: { integrity, tarball: `${base}agents-can-communicate/-/agents-can-communicate-${version}.tgz` } };
    if (req.url !== "/agents-can-communicate" && discoveryIntegrity !== null) release.dist.integrity = discoveryIntegrity;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/agents-can-communicate" ? {
      name: rootManifest.name, "dist-tags": { latest: version }, versions: { [version]: release },
    } : release));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}/`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { url: base, version, tarball, integrity, requests,
    setAvailable: value => { available = value; },
    setDiscoveryIntegrity: value => { discoveryIntegrity = value; } };
}
