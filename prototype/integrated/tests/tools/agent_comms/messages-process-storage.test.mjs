import assert from "node:assert/strict";
import test from "node:test";

import {
  listJsonFiles,
  readJsonStrict,
  writeJsonAtomic,
} from "../../../tools/agents/lib/atomic-json.mjs";
import { createBusPaths } from "../../../tools/agents/lib/paths.mjs";
import { validateMessage, validateRegistry } from "../../../tools/agents/lib/schema.mjs";
import { createGitWorktreeFixture, runCli, startCli } from "./helpers.mjs";

function waitForChild(child) {
  child.stdin.end();
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve({
      code,
      stdout: child.collected.stdout,
      stderr: child.collected.stderr,
    }));
  });
}

test("one hundred independent sender processes across worktrees lose no messages",
  { timeout: 60_000 }, async t => {
    const fixture = await createGitWorktreeFixture();
    t.after(fixture.cleanup);
    const initialized = await runCli(fixture, ["init", "--json"], { cwd: fixture.main });
    assert.equal(initialized.code, 0, initialized.stderr);
    const paths = createBusPaths(fixture.bus);
    const timestamp = "2026-08-14T18:00:00.000Z";
    const senderIds = Array.from({ length: 100 }, (_, index) =>
      `sender${String(index).padStart(3, "0")}`);
    const registrations = ["models", ...senderIds].map((agentId, index) =>
      validateRegistry({
        schema_version: 1,
        agent_id: agentId,
        role: agentId === "models" ? "recipient" : "sender",
        task: "M2.process-stress",
        worktree: index % 2 === 0 ? fixture.main : fixture.worktree,
        branch: index % 2 === 0 ? "main" : "linked",
        head: "a".repeat(40),
        ownership: [],
        status: "open",
        registered_at: timestamp,
        updated_at: timestamp,
      }));
    await Promise.all(registrations.map(record => writeJsonAtomic(
      paths.registryFile(record.agent_id),
      record,
      { tmpDir: paths.tmp, exclusive: true },
    )));

    const children = senderIds.map((sender, index) => startCli(fixture, [
      "send",
      "--from", sender,
      "--to", "models",
      "--type", "status",
      "--severity", "info",
      "--subject", `process ${index}`,
      "--body", `body ${index}`,
      "--json",
    ], { cwd: index % 2 === 0 ? fixture.main : fixture.worktree }));
    const results = await Promise.all(children.map(waitForChild));
    assert.ok(results.every(result => result.code === 0),
      results.filter(result => result.code !== 0).map(result => result.stderr).join("\n"));

    const files = await listJsonFiles(paths.inboxDir("models"), { root: paths.root });
    const messages = await Promise.all(files.map(file =>
      readJsonStrict(file, validateMessage, paths.root)));
    assert.equal(messages.length, 100);
    assert.equal(new Set(messages.map(message => message.id)).size, 100);
    assert.deepEqual(new Set(messages.map(message => message.from)), new Set(senderIds));
  });
