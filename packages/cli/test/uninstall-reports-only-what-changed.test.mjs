import assert from "node:assert/strict";
import test from "node:test";

import { describeChanges } from "../src/install-command.mjs";

/**
 * An uninstall that changed nothing must not say it edited anything.
 *
 * Measured on a real machine: after everything was already removed, a second
 * `acc uninstall` printed `edited` for six of the user's configuration files -
 * their Claude settings, two plugin registries, the Codex config, the Gemini
 * settings and a marketplace manifest - and the bytes of all six were
 * identical before and after. The lines came from the *plan*: every merge
 * artifact ACC had ever touched, listed whether or not this run touched it.
 *
 * The packed verifier already defines the no-op case as `changes` being empty,
 * so the report shown to a person now follows the same definition the release
 * gate uses. Overstating what was done is the same fault as overstating a
 * delivery, only quieter: it teaches people that the report is decoration.
 */
const uninstall = (changes, artifacts) => ({ action: "uninstall", changes,
  artifacts, removed: [], removedDirectories: [], kept: [] });

const MERGE = [{ path: "/home/u/.claude/settings.json", kind: "merge" },
  { path: "/home/u/.codex/config.toml", kind: "merge" }];

test("an uninstall that removed nothing reports no edits", () => {
  const lines = describeChanges(uninstall([], MERGE), "/home/u");

  assert.deepEqual(lines, [],
    "the second uninstall claimed it edited files whose bytes it never changed");
});

test("an uninstall that did remove something still names the files it edited", () => {
  const lines = describeChanges(uninstall(["enabledPlugins/acc"], MERGE), "/home/u");

  assert.deepEqual(lines, ["  edited  ~/.claude/settings.json",
    "  edited  ~/.codex/config.toml"]);
});

test("removals and retentions are reported from the run, not from the plan", () => {
  const lines = describeChanges({ action: "uninstall", changes: [], artifacts: MERGE,
    removed: ["/home/u/.claude/plugins/cache/acc-local"], removedDirectories: [],
    kept: ["/home/u/.gemini/extensions/acc/notes.md"] }, "/home/u");

  assert.deepEqual(lines, ["  removed ~/.claude/plugins/cache/acc-local",
    "  kept    ~/.gemini/extensions/acc/notes.md - changed since ACC wrote it"],
  "a run that removed a tree but edited no merge file must say exactly that");
});

// An install reports what its plan carried out, which is a different question:
// there the plan is the record of what was written.
test("an install still reports every file its plan wrote", () => {
  const lines = describeChanges({ action: "install", changes: [],
    artifacts: [{ path: "/home/u/.claude/plugins/cache/acc", kind: "tree" }, ...MERGE] },
  "/home/u");

  assert.deepEqual(lines, ["  created ~/.claude/plugins/cache/acc",
    "  edited  ~/.claude/settings.json", "  edited  ~/.codex/config.toml"]);
});
