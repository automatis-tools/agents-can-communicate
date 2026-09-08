import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { claimSpellingProject } from "../helpers/claim-spelling-project.mjs";
import { fixtureOwnerEnv } from "../helpers/fixture-owner.mjs";

const hookEnv = participant => ({ ACC_TEST_EXPIRE_PARTICIPANT: participant,
  NODE_OPTIONS: `--import=${pathToFileURL(path.resolve(import.meta.dirname,
    "../helpers/expire-hook-clock.mjs")).href}` });

for (const participant of ["holder", "writer"]) {
  test(`claim guard fixture refuses fail-open ${participant} SessionStart as ready`, async t => {
    await assert.rejects(claimSpellingProject(t, { hookEnv: hookEnv(participant) }),
      error => {
        assert.match(error.message,
          new RegExp(`claim fixture: ${participant} SessionStart did not establish usable context`));
        assert.match(error.message, /exit 0; stderr: acc: coordination unavailable/);
        return true;
      });
  });
}

test("claim rejection fixture uses a real CLI owner without hook startup", async t => {
  const place = await claimSpellingProject(t, { owner: "cli", hookEnv: hookEnv("holder") });
  // A positive command proves the CLI-returned pair owns a real session.
  assert.match((await place.claim("file:src/physics.mjs")).stdout, /claimed file:src\/physics.mjs/);
  await assert.rejects(fixtureOwnerEnv(place.env.ACC_DATA_HOME, "holder"),
    /fixture must own exactly one binding/);
  const failure = await place.claim("file:src/*.mjs").then(() => null, error => error);
  assert.equal(failure?.code, 2, failure?.message);
  assert.match(failure.stderr, /matches nothing: only a trailing \/\*\* is understood/);
});
