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
 * Checking npm for a newer ACC is a thing `acc update` does when a person asks,
 * and `acc doctor` reads what that remembered.
 *
 * Enforced structurally rather than by intention: the packages a hook loads may
 * not name a network module, call `fetch`, or import the one file that does.
 */
const HOOK_PATH = ["hook-runner", "adapter-sdk", "adapter-claude-code", "adapter-codex",
  "adapter-gemini-cli", "adapter-grok", "adapter-kimi", "core", "storage-filesystem",
  "protocol"];

const FORBIDDEN = [
  [/from\s+"node:(https?|net|tls|dgram)"/, "imports a network module"],
  [/\bfetch\s*\(/, "calls fetch"],
  [/update-check\.mjs/, "imports the update check"],
];

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
    .concat(path.join(repo, "bin", "acc-hook.mjs"));

  assert.equal(files.length > 20, true, "the scan found almost nothing, so it proves nothing");

  const offenders = [];
  for (const file of files) {
    const code = withoutComments(await readFile(file, "utf8"));
    for (const [pattern, what] of FORBIDDEN) {
      if (pattern.test(code)) offenders.push(`${path.relative(repo, file)} ${what}`);
    }
  }

  assert.deepEqual(offenders, [],
    "a hook runs every turn on a five-second budget and fails open; a stalled "
    + "socket in one of these would be invisible");
});

test("the file that does reach the network is reached only by the CLI", async () => {
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
