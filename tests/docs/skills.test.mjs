import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { COMMANDS } from "@agents-can-communicate/cli";

const repo = path.resolve(import.meta.dirname, "..", "..");

/**
 * A capability an agent is never told about does not exist.
 *
 * `acc task` shipped for the life of the project and no skill mentioned it, so
 * no agent ever created one and the only way to reach it was a human typing it
 * — in a product whose whole promise is that the human types nothing after
 * installing. The gap was invisible: the command worked, its tests passed, and
 * the surface it was missing from was a markdown file nobody diffed.
 */

// What an agent has to know how to do. Human-only commands (`install`,
// `uninstall`, `doctor`, `config`) and adapter-only ones (`attach`,
// `heartbeat`, `detach`) are deliberately absent — a skill that taught those
// would have models running the installer.
const TAUGHT = Object.freeze(["sync", "work", "claim", "request", "task", "message",
  "finish", "status", "ack"]);

// Reachable by an agent but not worth a section: `release` is covered by
// `finish`, and `workstream` and `decide` only matter once work is large enough,
// or a disagreement real enough, that the model will have read the CLI reference
// anyway. Four sections in every skill is four sections read on every turn.
const OPTIONAL = Object.freeze(["release", "workstream", "decide"]);

/** Every SKILL.md an adapter ships. */
async function skills() {
  const root = path.join(repo, "packages");
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const bundle of ["plugin", "extension"]) {
      const file = path.join(root, entry.name, bundle, "skills", "acc", "SKILL.md");
      const text = await readFile(file, "utf8").catch(() => null);
      if (text !== null) found.push({ file: path.relative(repo, file), text });
    }
  }
  return found;
}

test("every adapter ships a skill", async () => {
  const found = await skills();

  // Four adapters, four skills. A scan that found none would pass every
  // assertion below without reading anything.
  assert.equal(found.length, 4, found.map(item => item.file).join("\n"));
});

test("each skill teaches the operations an agent is expected to use", async () => {
  for (const { file, text } of await skills()) {
    for (const command of TAUGHT) {
      // `{{ACC}}` is the placeholder the installer replaces with this
      // machine's absolute invocation. The shipped file carries it; a skill
      // saying a bare `acc` would be telling agents to run something that is
      // not on PATH on every machine.
      assert.match(text, new RegExp(`\\{\\{ACC\\}\\} ${command}\\b`),
        `${file} never runs ${command}, so no agent will ever do it`);
    }
  }
});

test("the taught set stays honest about what the CLI offers", async () => {
  // Guards the list above rather than the skills: a new agent-facing command
  // added to the CLI has to be classified here on purpose, which is the moment
  // to notice it also needs teaching.
  const known = new Set([...TAUGHT, ...OPTIONAL,
    "install", "uninstall", "doctor", "config", "attach", "heartbeat", "detach",
    // Describe the program rather than the workspace: nothing to teach an agent,
    // which already receives the command list in its skill.
    "help", "version",
    // Asks npm about the package, which is a thing a person does to their
    // machine and not something an agent should be doing mid-turn.
    "update"]);
  const unclassified = Object.keys(COMMANDS).filter(command => !known.has(command));

  assert.deepEqual(unclassified, [],
    "a new command exists that no skill teaches and nothing here decided to skip");
});

test("the skills stay in step with each other", async () => {
  const found = await skills();
  const headings = ({ text }) => text.split("\n").filter(line => line.startsWith("## "));

  // They are one document shipped four times, differing only in which clients
  // they name. A section added to one and forgotten in the others means agents
  // on different clients coordinate differently for no reason.
  const [first, ...rest] = found;
  for (const other of rest) {
    assert.deepEqual(headings(other), headings(first),
      `${other.file} has drifted from ${first.file}`);
  }
});
