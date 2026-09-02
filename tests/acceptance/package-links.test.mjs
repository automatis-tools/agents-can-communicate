import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const isWindows = process.platform === "win32";
const runNpm = (args, options = {}) => (isWindows
  ? run("npm.cmd", args.map(argument => `"${argument}"`), { ...options, shell: true })
  : run("npm", args, options));

async function pack(t) {
  const into = await realpath(await mkdtemp(path.join(tmpdir(), "acc-links-")));
  t.after(() => rm(into, { recursive: true, force: true }));
  const { stdout } = await runNpm(["pack", "--pack-destination", into], { cwd: repo });
  return path.join(into, stdout.trim().split("\n").at(-1));
}

const entries = async tarball => new Set((await run("tar", ["-tzf", tarball])).stdout
  .split("\n").filter(Boolean).map(item => item.replace(/^package\//, "")));

const source = async (tarball, entry) => (await run("tar",
  ["-xzOf", tarball, `package/${entry}`])).stdout;

function localTargets(markdown, from) {
  const targets = [];
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const raw = match[1].replace(/^<|>$/g, "");
    if (/^(?:[a-z]+:|#)/i.test(raw)) continue;
    const local = decodeURIComponent(raw.split("#", 1)[0].split("?", 1)[0]);
    targets.push(path.posix.normalize(path.posix.join(path.posix.dirname(from), local)));
  }
  return targets;
}

test("every local link in packed documentation resolves in the tarball", async t => {
  const tarball = await pack(t);
  const listed = await entries(tarball);
  const markdown = [...listed].filter(entry => entry.endsWith(".md"));
  const missing = [];
  for (const entry of markdown) {
    for (const target of localTargets(await source(tarball, entry), entry)) {
      if (!listed.has(target)) missing.push(`${entry} -> ${target}`);
    }
  }
  assert.deepEqual(missing, [], `packed documentation has missing links:\n${missing.join("\n")}`);
});
