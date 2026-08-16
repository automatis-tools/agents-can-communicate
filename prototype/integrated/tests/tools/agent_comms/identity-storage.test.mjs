import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { EXIT } from "../../../tools/agents/lib/errors.mjs";
import { requireOpenAgent } from "../../../tools/agents/lib/identity.mjs";
import { createBusFixture, seedOpenAgent } from "./helpers.mjs";

test("registry reads reject a parent directory replaced by a symlink", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const record = await seedOpenAgent(fixture.context, { agentId: "visual" });
  const external = path.join(fixture.root, "external-registry");
  const externalFile = path.join(external, "visual.json");
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  await mkdir(external);
  await writeFile(externalFile, bytes);
  await rm(fixture.paths.registry, { recursive: true });
  await symlink(external, fixture.paths.registry);

  await assert.rejects(
    requireOpenAgent(fixture.context, "visual"),
    error => error.exitCode === EXIT.DATA,
  );
  assert.equal(await readFile(externalFile, "utf8"), bytes);
});
