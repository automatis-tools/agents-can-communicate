import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { COMMANDS } from "@agents-can-communicate/cli";
import { ATTENTION_PRIORITY, createCoordinationService }
  from "@agents-can-communicate/core";
import { PUBLIC_TOOLS } from "../../packages/mcp-server/src/tools.mjs";

import { createFakeClock, createFakeIds, createMemoryStore } from "../helpers/memory-store.mjs";

const repo = path.resolve(import.meta.dirname, "..", "..");

/**
 * An operation nothing can call does not exist.
 *
 * This has been a recurring defect of the project. Each one
 * was implemented in the core, tested at the core, and reachable from nothing:
 *
 *   markDelivery       so a `requiresAck` message raised an attention item that
 *                      could never be cleared
 *   nearby_intent      an attention kind with no rule behind it
 *
 * Every one passed its own tests. This is the gate that makes another of *this*
 * shape impossible to add quietly: a new core operation has to be given a
 * surface, or be named here as deliberately internal.
 *
 * The next one had a different shape and walked straight past this gate. Every
 * agent-facing command existed, was routed, and was documented - and required
 * `--session` and `--generation`, which no agent could obtain: nothing exported
 * them, and the generation is deliberately absent from `acc status`. An
 * operation whose required argument is unobtainable is as unreachable as one
 * with no command at all. That shape is gated by
 * `tests/process/session-resolution.test.mjs`, which runs each command the way
 * the skill tells an agent to run it.
 */
function coreOperations() {
  const clock = createFakeClock("2026-08-17T00:00:00.000Z");
  const store = createMemoryStore({ clock, ids: createFakeIds(), workspaceId: "workspace_a" });
  const service = createCoordinationService({ store, clock, ids: createFakeIds() });
  return Object.entries(service)
    .filter(([, value]) => typeof value === "function")
    .map(([name]) => name)
    .sort();
}

// Reachable by a person or an agent through `acc <command>`.
const BY_CLI = Object.freeze({
  openSession: "attach", heartbeatSession: "heartbeat", closeSession: "detach",
  sync: "sync", setIntent: "work", clearIntent: "work", acquireClaim: "claim", releaseClaim: "release",
  forceReleaseClaim: "release", sendMessage: "message", acknowledgeMessage: "ack",
  readInbox: "inbox", replyToMessage: "reply",
  finishSession: "finish", collectStatus: "status",
});

// Deliberately internal, each for a stated reason rather than by omission.
const INTERNAL = Object.freeze({
  ensureMaterialised: "called by every write that needs durable state",
  locateSession: "a lookup the other operations share",
  pendingMessages: "read by the hook runtime when it builds a turn",
  nextTurnDelivery: "the hook runtime's receipt-backed message and offer evidence",
  renewClaim: "reached through `acc claim` on a claim this session already holds",
  guardState: "the write guard's own read, kept narrow on purpose: `collectStatus` "
    + "answers the same question and reads the whole store, which put the cost of "
    + "guarding one write in proportion to every message the workspace had carried",
  resumeSession: "the hook runtime resumes its generation-bearing binding after compaction",
  recordOfferSucceeded: "called only after a transport proves it crossed its boundary",
  recordOfferFailed: "called by the delivery router to append a safe failed-attempt event",
});

test("every core operation is reachable, or named as internal on purpose", () => {
  const unreachable = coreOperations().filter(name =>
    !Object.hasOwn(BY_CLI, name) && !Object.hasOwn(INTERNAL, name));

  assert.deepEqual(unreachable, [],
    "these exist in the core and nothing can call them - give them a surface or "
    + "say here why they are internal");
});

test("every command the CLI claims to route actually exists", () => {
  const missing = [...new Set(Object.values(BY_CLI))]
    .filter(command => !Object.hasOwn(COMMANDS, command));

  // Guards the map above rather than the code: a renamed command would
  // otherwise leave this test passing against a command nobody can run.
  assert.deepEqual(missing, []);
});

test("the internal list stays a list of decisions, not of leftovers", () => {
  const stale = Object.keys(INTERNAL).filter(name => !coreOperations().includes(name));

  // An entry for an operation that no longer exists is a note about nothing, and
  // hides the next one that does need a decision.
  assert.deepEqual(stale, []);
});

test("an operation an agent needs is offered over MCP as well", async () => {
  // A client with no adapter reaches ACC only through tools. The agent-facing
  // set is what an agent has to be able to do; setup and lifecycle are not part
  // of it, since a model should not be running the installer.
  const names = new Set(PUBLIC_TOOLS.map(tool => tool.name));
  for (const operation of ["collectStatus", "sync", "setIntent", "acquireClaim",
    "releaseClaim", "sendMessage", "readInbox", "replyToMessage", "acknowledgeMessage",
    "finishSession"]) {
    const expected = { collectStatus: "acc_status", sync: "acc_sync", setIntent: "acc_work",
      acquireClaim: "acc_claim", releaseClaim: "acc_release", sendMessage: "acc_message",
      acknowledgeMessage: "acc_ack", readInbox: "acc_inbox",
      replyToMessage: "acc_reply", finishSession: "acc_finish" }[operation];
    assert.equal(names.has(expected), true, `${operation} has no MCP tool`);
  }
});

test("every attention rule is documented, and the documentation invents none", async () => {
  // `request_stalled` was added, shipped, and never written down: the protocol
  // reference said "four explicit rules" and named four while the code computed
  // five. A rule an agent is never told about is one it cannot be expected to
  // act on, and the skills are generated from the same vocabulary.
  const architecture = await readFile(path.join(repo, "docs", "ARCHITECTURE.md"), "utf8");
  const protocol = await readFile(path.join(repo, "docs", "PROTOCOL.md"), "utf8");
  const kinds = Object.keys(ATTENTION_PRIORITY);

  for (const kind of kinds) {
    assert.match(architecture, new RegExp(`\\\`${kind}\\\``),
      `${kind} has no row in the architecture table`);
    assert.match(protocol, new RegExp(`\\\`${kind}\\\``),
      `${kind} is not named in the protocol reference`);
  }
  // The count in the prose is the part that goes stale silently.
  const counted = ["zero", "one", "two", "three", "four", "five", "six", "seven",
    "eight"][kinds.length];
  assert.match(protocol, new RegExp(`${counted} explicit\\s+rules`),
    `the protocol reference does not say there are ${counted} rules`);

  // Only the priority table: the document has other tables, and one of them has
  // a row called `protocol`.
  for (const [, named] of architecture.matchAll(/^\| \d+ \| `([a-z_]+)` \|/gm)) {
    assert.equal(kinds.includes(named), true,
      `the architecture table describes \`${named}\`, which the core does not compute`);
  }
});

test("the CLI reference documents every command, and invents none", async () => {
  const reference = await readFile(path.join(repo, "docs", "CLI.md"), "utf8");
  const documented = new Set([...reference.matchAll(/`acc ([a-z-]+)/g)]
    .map(match => match[1]));

  for (const command of Object.keys(COMMANDS)) {
    assert.equal(documented.has(command), true, `acc ${command} is not documented`);
  }
  for (const name of documented) {
    assert.equal(Object.hasOwn(COMMANDS, name), true,
      `docs/CLI.md documents \`acc ${name}\`, which the CLI does not accept`);
  }
});
