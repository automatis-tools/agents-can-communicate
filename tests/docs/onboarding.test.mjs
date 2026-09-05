import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repo = path.resolve(import.meta.dirname, "..", "..");

test("getting started follows the user journey and names its boundaries", async () => {
  const guide = await readFile(path.join(repo, "docs", "GETTING_STARTED.md"), "utf8");

  assert.match(guide, /npm install -g agents-can-communicate/,
    "onboarding does not install the package before configuring clients");
  assert.match(guide, /acc install/, "onboarding lost the client integration step");
  assert.equal(/(?:restart|reopen)[^\n]*clients?/i.test(guide), true,
    "onboarding does not tell readers that clients must reload their integrations");
  assert.match(guide, /(?:ordinary|normal)[^\n]*tasks?/i,
    "onboarding no longer starts with ordinary user tasks");
  assert.match(guide, /(?:watch|look for|observe)[\s\S]{0,160}(?:discover|message|dependency|coordinate)/i,
    "onboarding does not say how a reader can observe coordination");

  assert.match(guide, /(?:cannot|does not)[\s\S]{0,80}guarantee[\s\S]{0,100}coordinate/i,
    "onboarding implies that integration guarantees model coordination");
  assert.match(guide, /next normal turn/i,
    "onboarding hides the normal delivery boundary");
  assert.match(guide, /durable inbox/i,
    "onboarding hides the universal delivery fallback");

  for (const required of ["acc doctor", "acc uninstall", "CAPABILITIES.md",
    "TROUBLESHOOTING.md"]) {
    assert.match(guide, new RegExp(required.replaceAll(".", "\\.")), `missing: ${required}`);
  }

  assert.doesNotMatch(guide,
    /(?:ask|tell|prompt)[^\n]*(?:use ACC|check (?:its|your|the) inbox|ask (?:Claude|Codex|the other session))/i,
    "onboarding makes the user operate the coordination channel");
});
