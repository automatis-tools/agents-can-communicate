import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MODULES } from "../src/managed-runtime/launchers.mjs";

// The launchers copy these modules and nothing else, so a relative import of
// any other module fails there and only there. `schedule.mjs` importing the
// store migration failed every hook with ERR_MODULE_NOT_FOUND, caught by a real
// Claude Code session, not by the unit tests (2026-10-06).
test("every launcher module imports only other launcher modules", async () => {
  for (const name of MODULES) {
    const source = await readFile(new URL(`../src/managed-runtime/${name}`, import.meta.url), "utf8");
    const relative = [...source.matchAll(/(?:from|import)\s*\(?\s*["'](\.\.?\/[^"']+)["']/g)].map(match => match[1]);
    for (const specifier of relative) {
      assert.ok(specifier.startsWith("./") && MODULES.includes(specifier.slice(2)),
        `${name} imports ${specifier}, which the launchers do not copy`);
    }
  }
});
