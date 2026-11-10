import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { pathWithoutClients } from "../helpers/path-without-clients.mjs";

test("a PATH for a throwaway home hides real clients and keeps this Node first", async t => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-path-clients-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const clients = path.join(base, "clients");
  const tools = path.join(base, "tools");
  await mkdir(clients);
  await mkdir(tools);
  await writeFile(path.join(clients, "codex"), "");

  const entries = pathWithoutClients({ PATH: [clients, tools].join(path.delimiter) }).split(path.delimiter);

  assert.equal(entries[0], path.dirname(process.execPath));
  assert.equal(entries.includes(clients), false);
  assert.equal(entries.includes(tools), true);
});
