import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createCoordinationService } from "@agents-can-communicate/core";
import { EXIT, SCHEMA_VERSION } from "@agents-can-communicate/protocol";

import { createFakeClock, createFakeIds, createMemoryStore } from "../helpers/memory-store.mjs";

const repo = path.resolve(import.meta.dirname, "..", "..");

/**
 * What a write is allowed to read.
 *
 * Every transaction read every record the workspace held, for the generation
 * checks `put` makes. That put the cost of a write in proportion to everything
 * already stored - 400 messages written one after another took 163 seconds -
 * and some of these transactions run inside hooks, where the budget is five
 * seconds and running out means failing open.
 *
 * `kinds` is enforced rather than merely honoured. A silent empty list would be
 * the worst of both: every check these transactions make reads as "nothing
 * conflicts" when it finds nothing, so a missed declaration would turn a
 * conflict check into a rubber stamp. It has already caught one that no static
 * reading could - `materialise` names its kinds in a loop, so nothing in its
 * body says what it touches.
 */
function spy() {
  const clock = createFakeClock("2026-08-23T00:00:00.000Z");
  const store = createMemoryStore({ clock, ids: createFakeIds(), workspaceId: "workspace_a" });
  const declarations = [];
  const wrapped = { ...store,
    transaction: (callback, options) => {
      declarations.push(options?.kinds);
      return store.transaction(callback, options);
    } };
  return { declarations, store: wrapped,
    service: createCoordinationService({ store: wrapped, clock, ids: createFakeIds() }) };
}

const descriptor = { id: "workspace_a", roots: ["/tmp/x"], source: "directory",
  displayName: "x" };
const open = (service, participantId) => service.openSession({ workspaceId: "workspace_a",
  participantId, displayName: participantId, harness: "cli",
  heartbeatCadenceMs: 30_000, descriptor });

// The unbounded kinds: nothing limits how many of these a workspace collects.
const UNBOUNDED = Object.freeze(["message", "receipt", "event"]);

test("every transaction says what it reads", async () => {
  const { declarations, service } = spy();
  const session = await open(service, "solo");
  const other = await open(service, "peer");
  await service.setIntent({ sessionId: session.sessionId, generation: session.generation,
    summary: "working", mode: "edit" });
  await service.acquireClaim({ sessionId: session.sessionId, generation: session.generation,
    resource: "file:src/a.mjs", reason: "editing", descriptor });
  await service.sendMessage({ sessionId: session.sessionId, generation: session.generation,
    toParticipantIds: ["peer"], type: "note", subject: "s", body: "b", descriptor });
  await service.requestWork({ sessionId: session.sessionId, generation: session.generation,
    toParticipantId: "peer", title: "please take this", descriptor });
  await service.closeSession({ sessionId: other.sessionId, generation: other.generation });

  assert.equal(declarations.length > 0, true);
  const undeclared = declarations.filter(kinds => kinds === undefined).length;
  assert.equal(undeclared, 0,
    `${undeclared} of ${declarations.length} transactions read the whole store`);
});

test("attaching and heartbeating read nothing that grows without limit", async () => {
  // These two are the hook path. A session that cannot attach inside the budget
  // is a session that never joins, and the failure is silent.
  const { declarations, service } = spy();
  // A lone session stays ephemeral and opens no transaction at all, so without
  // this the assertion below has nothing to be true about.
  const first = await open(service, "first");
  await service.acquireClaim({ sessionId: first.sessionId, generation: first.generation,
    resource: "file:src/a.mjs", reason: "editing", descriptor });
  declarations.length = 0;

  const session = await open(service, "solo");
  await service.heartbeatSession({ sessionId: session.sessionId,
    generation: session.generation });

  assert.equal(declarations.length > 0, true, "no transaction was opened to inspect");
  for (const kinds of declarations) {
    for (const kind of UNBOUNDED) {
      assert.equal(kinds.includes(kind), false,
        `attaching reads every ${kind} in the workspace: ${JSON.stringify(kinds)}`);
    }
  }
});

test("reaching for an undeclared kind fails loudly", async () => {
  const { store } = spy();

  const failure = await store.transaction(async tx => tx.list("message"),
    { kinds: ["session"] }).then(() => null, error => error);

  // Loudly, because the quiet version is worse than the cost it saves: a
  // conflict check that finds nothing reports no conflict.
  assert.notEqual(failure, null, "an undeclared read returned silently");
  assert.equal(failure.code, EXIT.DATA);
  assert.match(failure.message, /did not declare message/);
});

test("declaring nothing still reads everything", async () => {
  const { store } = spy();
  await store.transaction(async tx => {
    tx.put("workspace", "workspace_a", { schemaVersion: SCHEMA_VERSION,
      workspaceId: "workspace_a",
      displayName: "x", source: "directory", roots: ["/tmp/x"],
      createdAt: "2026-08-23T00:00:00.000Z" });
  }, { kinds: ["workspace"] });

  // No declaration is the old behaviour, kept so a caller outside this package
  // is not broken by a contract it never opted into.
  const seen = await store.transaction(async tx => tx.list("workspace").length);

  assert.equal(seen, 1);
});

test("the two stores enforce the same contract", async () => {
  // A double that waves the declaration through lets a transaction reach for
  // something it never read, pass every test, and find nothing in production.
  const filesystem = await readFile(
    path.join(repo, "packages", "storage-filesystem", "src", "store.mjs"), "utf8");
  const double = await readFile(path.join(repo, "tests", "helpers", "memory-store.mjs"), "utf8");

  for (const source of [filesystem, double]) {
    assert.match(source, /did not declare \$\{kind\}/);
    // Every reader and writer on the handle, not only the ones easy to reach.
    assert.equal((source.match(/declared\(kind\)/g) ?? []).length, 5);
  }
});

test("no transaction in the core is left undeclared", async () => {
  // The runtime spy above only sees the operations it exercises. This sees them
  // all, including the ones no test drives yet.
  const dir = path.join(repo, "packages", "core", "src");
  const missing = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".mjs")) continue;
    const source = await readFile(path.join(dir, name), "utf8");
    // Counting `kinds:` would count the scoped reads too, which are a different
    // thing. Each call is matched to its own closing paren instead.
    for (let at = source.indexOf("store.transaction("); at !== -1;
      at = source.indexOf("store.transaction(", at + 1)) {
      let depth = 0;
      let index = source.indexOf("(", at);
      for (; index < source.length; index += 1) {
        if (source[index] === "(") depth += 1;
        else if (source[index] === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const call = source.slice(at, index);
      const line = source.slice(0, at).split("\n").length;
      if (!call.includes("{ kinds:")) missing.push(`${name}:${line}`);
    }
  }
  assert.deepEqual(missing, [],
    "these read the whole store, and one of them runs in front of a turn");
});
