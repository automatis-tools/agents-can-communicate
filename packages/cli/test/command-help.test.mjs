import assert from "node:assert/strict";
import test from "node:test";

import { EXIT, SCHEMA_VERSION, VALID_OBLIGATIONS, validateRecord }
  from "@agents-can-communicate/protocol";

import { parseArgs } from "../src/args.mjs";
import { commandHelpText, describeCommand } from "../src/help.mjs";
import { ALL_ADAPTERS, decideDelivery } from "../src/install-command.mjs";

test("config help describes the selected subcommand's options and purpose", () => {
  const init = describeCommand("config", "init");
  const validate = describeCommand("config", "validate");
  assert.deepEqual(init.flags, ["yes", "force"]);
  assert.deepEqual(validate.flags, []);
  assert.match(init.summary, /write/);
  assert.doesNotMatch(init.summary, /check|validate/);
  assert.match(validate.summary, /check|validate/);
  assert.doesNotMatch(validate.summary, /write|init/);
  assert.match(commandHelpText(init), /confirmation or --yes/);
  assert.doesNotMatch(commandHelpText(validate), /--yes|--force|init requires/);
});

test("config validate rejects init-only flags instead of silently dropping them", () => {
  for (const flag of ["--yes", "--force"]) {
    assert.equal(parseArgs(["config", "init", flag]).options[flag.slice(2)], true);
    assert.throws(() => parseArgs(["config", "validate", flag]),
      error => error.code === EXIT.USAGE && error.message.includes(flag));
  }
});

test("install and uninstall help list the adapter ids accepted by the installer", () => {
  const ids = ALL_ADAPTERS().map(adapter => adapter.id);
  for (const name of ["install", "uninstall"]) {
    const help = describeCommand(name);
    assert.deepEqual(help.choices.adapter, ids);
    assert.ok(commandHelpText(help).includes(`--adapter <${ids.join("|")}>`));
  }
});

test("help advertises workspace options only where they have an effect", () => {
  for (const name of ["install", "uninstall", "update", "help", "version"]) {
    const text = commandHelpText(describeCommand(name));
    assert.doesNotMatch(text, /--cwd|--workspace/, name);
    assert.match(text, /--json.*--help.*-h/);
  }
  for (const name of ["work", "status", "doctor"]) {
    assert.match(commandHelpText(describeCommand(name)), /--cwd.*--workspace/);
  }
  assert.match(commandHelpText(describeCommand("config", "init")), /--cwd.*--workspace/);
  const validate = commandHelpText(describeCommand("config", "validate"));
  assert.match(validate, /--cwd/);
  assert.doesNotMatch(validate, /--workspace/);
});

test("the help command has its own page while bare help keeps the command list", () => {
  for (const argv of [["help", "help"], ["help", "--help"], ["help", "-h"]]) {
    assert.deepEqual(parseArgs([...argv, "--json"]),
      { command: "help", options: { helpCommand: "help", json: true } });
  }
  for (const spelling of ["help", "--help", "-h"]) {
    assert.deepEqual(parseArgs([spelling, "--json"]),
      { command: "help", options: { json: true } });
  }
});

test("advertised intent and claim values pass their record validators", () => {
  const now = "2026-09-07T00:00:00.000Z";
  const base = { schemaVersion: SCHEMA_VERSION, workspaceId: "workspace_test" };
  const intent = { ...base, sessionId: "session_test", summary: "Review help",
    mode: "review", state: "active", resourceHints: [], updatedAt: now };
  const claim = { ...base, claimId: "claim_test", ownerSessionId: "session_test",
    resource: "file:example.mjs", mode: "exclusive", enforcement: "advisory",
    reason: "Review help", acquiredAt: now, expiresAt: now, generation: "generation_test" };
  for (const [command, kind, fixture] of [["work", "intent", intent], ["claim", "claim", claim]]) {
    for (const [field, values] of Object.entries(describeCommand(command).choices)) {
      assert.ok(values.length > 0, `${command}.${field} is empty`);
      for (const value of values) {
        assert.equal(validateRecord(kind, { ...fixture, [field]: value })[field], value);
      }
    }
  }
});

test("advertised message choices and handoff statuses pass message validation", () => {
  const fixture = { schemaVersion: SCHEMA_VERSION, workspaceId: "workspace_test",
    messageId: "message_test", threadId: "message_test", clientMessageId: "client_test",
    fromParticipantId: "author", fromSessionId: "session_test", toParticipantIds: ["reviewer"],
    kind: "note", obligation: "none", subject: "Help review", body: "Evidence",
    inReplyTo: null, artifacts: [], handoff: null, sentAt: "2026-09-07T00:00:00.000Z" };
  const choices = describeCommand("message").choices;
  const usedObligations = new Set();
  for (const kind of choices.type) {
    const obligations = choices.obligation.filter(value => VALID_OBLIGATIONS[kind]?.includes(value));
    assert.ok(obligations.length > 0, `${kind} has no accepted obligation`);
    for (const obligation of obligations) {
      assert.equal(validateRecord("message", { ...fixture, kind, obligation }).kind, kind);
      usedObligations.add(obligation);
    }
  }
  assert.deepEqual([...usedObligations].sort(), [...choices.obligation].sort());
  for (const status of describeCommand("finish").choices.status) {
    const handoff = { status, completed: [], remaining: [], blockers: [], verification: [] };
    const result = validateRecord("message", { ...fixture, kind: "handoff",
      obligation: "acknowledge", handoff });
    assert.equal(result.handoff.status, status);
  }
});

test("advertised delivery policies pass selection without probing or installing clients", async () => {
  for (const delivery of describeCommand("install").choices.delivery) {
    const result = await decideDelivery({ options: { delivery },
      detected: [{ adapterId: "fixture" }], recorded: [], runtime: {}, dryRun: true, context: {} });
    assert.equal(result.deliveryByAdapter.fixture, delivery);
  }
});
