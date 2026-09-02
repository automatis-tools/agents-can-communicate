import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { parseArgs } from "../src/args.mjs";

const message = (...extra) => ["message", "--session", "session_a", "--generation",
  "generation_a", "--to", "models", "--subject", "s", "--body", "b", ...extra];

test("a free-text value may begin with dashes", () => {
  // The case that matters for this product: an agent sending a diff.
  const diff = "--- a/file\n+++ b/file";
  const parsed = parseArgs(["message", "--session", "session_a", "--generation",
    "generation_a", "--to", "models", "--subject", "--important", "--body", diff]);

  assert.equal(parsed.options.subject, "--important");
  assert.equal(parsed.options.body, diff);
});

test("a missing value is still caught when the next token is a real option", () => {
  assert.throws(() => parseArgs(["message", "--session", "session_a", "--generation",
    "generation_a", "--to", "models", "--subject", "--body", "b"]),
  error => error.code === EXIT.USAGE && error.message.includes("--subject requires a value"));
});

test("a trailing option with no value at all is a usage error", () => {
  assert.throws(() => parseArgs(["status", "--participant"]),
    error => error.code === EXIT.USAGE && error.message.includes("requires a value"));
});

test("the inline form is unambiguous even when the value names an option", () => {
  const parsed = parseArgs(message("--obligation=--json"));

  assert.equal(parsed.options.obligation, "--json");
  assert.equal(parsed.options.json, undefined);
});

test("the inline form carries values containing an equals sign", () => {
  const parsed = parseArgs(["message", "--session", "session_a", "--generation",
    "generation_a", "--to", "models", "--subject", "s", "--body=a=b=c"]);

  assert.equal(parsed.options.body, "a=b=c");
});

test("an empty value is rejected in both forms", () => {
  assert.throws(() => parseArgs(["status", "--participant="]),
    error => error.code === EXIT.USAGE);
  assert.throws(() => parseArgs(["status", "--participant", ""]),
    error => error.code === EXIT.USAGE);
});

test("send boundaries accept caller idempotency keys and the v0.2 obligation", () => {
  assert.deepEqual(parseArgs(message("--client-message-id", "client_a",
    "--obligation", "acknowledge")).options,
  { session: "session_a", generation: "generation_a", to: ["models"], subject: "s",
    body: "b", clientMessageId: "client_a", obligation: "acknowledge" });
  assert.equal(parseArgs(["request", "--to", "models", "--title", "Review",
    "--client-message-id", "client_request"]).options.clientMessageId, "client_request");
  assert.equal(parseArgs(["reply", "--message", "message_a", "--body", "Done",
    "--client-message-id", "client_reply"]).options.clientMessageId, "client_reply");
  assert.equal(parseArgs(["finish", "--goal", "Ship",
    "--client-message-id", "client_finish"]).options.clientMessageId, "client_finish");
});

test("legacy acknowledgement and transport-state controls are absent", () => {
  assert.throws(() => parseArgs(message("--requires-ack")),
    error => error.code === EXIT.USAGE && /unknown option/.test(error.message));
  assert.throws(() => parseArgs(["ack", "--message", "message_a", "--state", "offered"]),
    error => error.code === EXIT.USAGE && /unknown option/.test(error.message));
});

test("intent publishing has no legacy orchestration handle", () => {
  assert.throws(() => parseArgs(["work", "--summary", "Review", "--workstream", "ws_a"]),
    error => error.code === EXIT.USAGE && /unknown option/.test(error.message));
});

test("repeated options accumulate and single options refuse repetition", () => {
  const parsed = parseArgs(["message", "--session", "session_a", "--generation",
    "generation_a", "--to", "models", "--to", "ops", "--subject", "s", "--body", "b"]);

  assert.deepEqual(parsed.options.to, ["models", "ops"]);
  assert.throws(() => parseArgs(message("--obligation", "none", "--obligation", "reply")),
    error => error.code === EXIT.USAGE && error.message.includes("only once"));
});

test("unknown commands and options are usage errors", () => {
  assert.throws(() => parseArgs(["teleport"]), error => error.code === EXIT.USAGE);
  assert.throws(() => parseArgs(message("--colour", "blue")),
    error => error.code === EXIT.USAGE && error.message.includes("--colour"));
  assert.throws(() => parseArgs([]), error => error.code === EXIT.USAGE);
});

test("a bare double dash is not an option name", () => {
  assert.throws(() => parseArgs(["status", "--"]),
    error => error.code === EXIT.USAGE && error.message.includes("unexpected argument"));
});

test("required options are still enforced", () => {
  assert.throws(() => parseArgs(["attach"]),
    error => error.code === EXIT.USAGE && error.message.includes("--participant"));
  assert.equal(parseArgs(["attach", "--participant", "visual"]).options.participant, "visual");
});

test("inbox targets an optional message and reply requires message plus body", () => {
  assert.equal(parseArgs(["inbox", "--message", "message_a"]).options.message, "message_a");
  assert.deepEqual(parseArgs(["inbox"]).options, {});
  assert.deepEqual(parseArgs(["reply", "--message", "message_a", "--body", "Done"])
    .options, { message: "message_a", body: "Done" });
  assert.throws(() => parseArgs(["reply", "--message", "message_a"]),
    error => error.code === EXIT.USAGE && error.message.includes("--body"));
});

test("install and uninstall accept --adapter more than once", () => {
  assert.deepEqual(parseArgs(["install", "--adapter", "claude_code", "--adapter", "codex"])
    .options.adapter, ["claude_code", "codex"]);
  assert.deepEqual(parseArgs(["uninstall", "--adapter", "codex"]).options.adapter, ["codex"]);
  assert.equal(parseArgs(["install"]).options.adapter, undefined);
});

test("install delivery policy is explicit and closed", () => {
  assert.equal(parseArgs(["install"]).options.delivery, undefined);
  assert.equal(parseArgs(["install", "--delivery", "actionable"]).options.delivery,
    "actionable");
  assert.throws(() => parseArgs(["uninstall", "--delivery", "all"]),
    error => error.code === EXIT.USAGE && /unknown option/.test(error.message));
});
