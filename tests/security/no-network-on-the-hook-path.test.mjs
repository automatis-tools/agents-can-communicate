import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repo = path.resolve(import.meta.dirname, "..", "..");

/**
 * Nothing a turn runs is allowed to reach the network.
 *
 * A hook runs on every turn of every session inside a five-second budget and
 * fails open, so a stalled socket there would cost every turn on the machine
 * something and report nothing - the failure would be invisible by design.
 * Automatic update networking runs in a detached worker; the hook only schedules it.
 * CLI update commands may explicitly wait for a check or download.
 *
 * Enforced structurally rather than by intention: the packages a hook loads may
 * not name a remote network module, call `fetch`, or import the one file that does.
 *
 * Native delivery is the one bounded exception, and only to a *local* Unix
 * socket. The hook's native-binding retry and the delivery router open a
 * session-scoped Unix domain socket to a vendor process on the same machine,
 * always raced against a sub-second timeout and always failing open. That is
 * categorically different from a remote fetch that can stall unbounded, so
 * `node:net` is allowed - but only in the named native-transport files below,
 * which connect to a socket path and never to a host and port, and never touch
 * a remote module or `fetch`.
 */
const HOOK_PATH = ["hook-runner", "adapter-sdk", "adapter-claude-code", "adapter-codex",
  "adapter-gemini-cli", "adapter-grok", "adapter-kimi", "core", "storage-filesystem",
  "protocol"];

// Reached only by the delivery router and the Channel binary, or by the hook's
// bounded fail-open native handshake; each connects to a local Unix socket path.
const NATIVE_TRANSPORT = new Set(["channel.mjs", "native-delivery.mjs", "ws-json-rpc.mjs",
  "app-server-client.mjs"]);

// Remote reachability is forbidden everywhere on the hook path. A local Unix
// socket (node:net) is forbidden too, except in the named native-transport
// files.
const BOOTSTRAP_MODULES = ["entry.mjs", "state.mjs", "mutex.mjs", "leases.mjs", "schedule.mjs", "policy.mjs"];
const bootstrap = path.join(repo, "packages", "cli", "src", "managed-runtime");

const REMOTE = [
  [/\bfetch\s*\(/, "calls fetch"],
  [/update-check\.mjs/, "imports the update check"],
];
// Include side-effect imports and literal dynamic imports, with either quote
// style. Matching only `from` let an imported worker escape the closed set.
const dependencies = code => Array.from(code.matchAll(
  /\b(?:from\s+|import\s*(?:\(\s*)?)["']([^"']+)["']/g), match => match[1]);
// A native-transport file may open a Unix socket but must never name a host and
// port or a remote module.
const HOST_PORT = /createConnection\(\s*\{[^}]*\bport\b/;

// Prose says "fetch" for perfectly good reasons; code is what this is about.
const withoutComments = text => text
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*(\/\/|\*)/.test(line)).join("\n");

async function sources(directory) {
  const found = [];
  const walk = async where => {
    for (const entry of await readdir(where, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = path.join(where, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".mjs")) found.push(full);
    }
  };
  await walk(directory);
  return found;
}

test("nothing a turn runs can reach the network", async () => {
  const files = (await Promise.all(HOOK_PATH
    .map(workspace => sources(path.join(repo, "packages", workspace, "src")))))
    .flat()
    .concat(path.join(repo, "bin", "acc-hook.mjs"),
      path.join(repo, "bin", "entrypoints", "acc-hook.mjs"),
      path.join(repo, "bin", "entrypoints", "hook-output.mjs"),
      BOOTSTRAP_MODULES.map(name => path.join(bootstrap, name)));

  assert.equal(files.length > 20, true, "the scan found almost nothing, so it proves nothing");

  const offenders = [];
  for (const file of files) {
    const code = withoutComments(await readFile(file, "utf8"));
    for (const dependency of dependencies(code)) {
      if (path.dirname(file) === bootstrap && !dependency.startsWith("node:")
        && !BOOTSTRAP_MODULES.some(name => dependency === `./${name}`)) {
        offenders.push(`${path.relative(repo, file)} reaches outside the closed launcher module set`);
      }
      if (/^(?:node:)?(?:https?|tls|dgram|dns)$/.test(dependency)) {
        offenders.push(`${path.relative(repo, file)} imports a remote network module`);
      }
      if (/^(?:node:)?net$/.test(dependency) && !NATIVE_TRANSPORT.has(path.basename(file))) {
        offenders.push(`${path.relative(repo, file)} imports node:net outside a native-transport file`);
      }
    }
    for (const [pattern, what] of REMOTE) {
      if (pattern.test(code)) offenders.push(`${path.relative(repo, file)} ${what}`);
    }
    if (NATIVE_TRANSPORT.has(path.basename(file))) {
      if (HOST_PORT.test(code)) {
        offenders.push(`${path.relative(repo, file)} opens a host/port socket, not a Unix socket`);
      }
      continue;
    }
  }

  assert.deepEqual(offenders, [],
    "a hook runs every turn on a five-second budget and fails open; a remote "
    + "socket in one of these would be invisible, and node:net is confined to the "
    + "bounded local-Unix-socket native-transport files");
});

test("the legacy update check is reached only by the CLI", async () => {
  // Guards the list above rather than the code: if the check moved somewhere
  // else, the scan would be looking in the wrong place and still pass.
  const users = [];
  for (const file of await sources(path.join(repo, "packages", "cli", "src"))) {
    if (/update-check\.mjs/.test(await readFile(file, "utf8"))) {
      users.push(path.basename(file));
    }
  }

  assert.deepEqual(users.sort(), ["doctor-command.mjs", "update-command.mjs"],
    "the network check moved, so the scan above is looking in the wrong place");
});
