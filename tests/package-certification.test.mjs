import assert from "node:assert/strict";
import test from "node:test";

import { verifyCertificationFixtureAllowlist } from "../scripts/package-certification.mjs";

const certification = { evidence: [{
  fixture: "fixtures/SessionStart.json",
  provenance: "fixtures/certification-provenance.json",
}] };

test("packed adapter fixtures are an exact allowlist of certification references", async () => {
  const root = "node_modules/@agents-can-communicate/adapter-codex";
  const base = [`${root}/certification.json`, `${root}/fixtures/SessionStart.json`,
    `${root}/fixtures/certification-provenance.json`];
  const readJson = async () => certification;

  await assert.doesNotReject(verifyCertificationFixtureAllowlist(base, readJson));
  await assert.rejects(verifyCertificationFixtureAllowlist([
    ...base, `${root}/fixtures/documentation-example.json`,
  ], readJson), /unreferenced certification fixture/);
  await assert.rejects(verifyCertificationFixtureAllowlist(base.filter(entry =>
    !entry.endsWith("SessionStart.json")), readJson), /certification fixture is missing/);
});
