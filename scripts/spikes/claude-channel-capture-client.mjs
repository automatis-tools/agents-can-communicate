#!/usr/bin/env node
// Terminal B of the Claude Channel capture: hand one envelope to the endpoint
// that the Channel child registered for terminal A's Claude session.
//
// usage: claude-channel-capture-client.mjs --socket <absolute path> --nonce <hex>
//   --message-id <id> --kind <question|request|answer|decision|handoff|note>
//   --subject <text> --body <text> [--in-reply-to <id>]
//
// Prints exactly one JSON line. Exit 0: accepted (duplicate or not). Exit 1: the
// channel rejected the envelope. Exit 2: usage. Exit 3: the endpoint was
// unreachable or did not answer in time. Observations stay with the channel.

import net from "node:net";
import path from "node:path";
import readline from "node:readline";

const TIMEOUT_MS = 5_000;
const MESSAGE_KINDS = new Set(["question", "request", "answer", "decision", "handoff", "note"]);
const FLAGS = new Map([
  ["--socket", "socket"], ["--nonce", "nonce"], ["--message-id", "messageId"],
  ["--kind", "kind"], ["--subject", "subject"], ["--body", "body"],
  ["--in-reply-to", "inReplyTo"],
]);

const options = parseArgs(process.argv.slice(2));
const envelope = {
  nonce: options.nonce,
  messageId: options.messageId,
  kind: options.kind,
  subject: options.subject,
  body: options.body,
  ...(options.inReplyTo === undefined ? {} : { inReplyTo: options.inReplyTo }),
};

const socket = net.createConnection(options.socket);
const timer = setTimeout(() => finish(3,
  { accepted: false, reasonCode: "timeout", messageId: options.messageId }), TIMEOUT_MS);
socket.once("error", (error) => finish(3, { accepted: false, reasonCode: "transport_unavailable",
  messageId: options.messageId, code: error.code ?? null }));
socket.once("connect", () => {
  socket.write(`${JSON.stringify(envelope)}\n`);
  readline.createInterface({ input: socket }).once("line", (line) => {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      finish(3, { accepted: false, reasonCode: "invalid_response", messageId: options.messageId });
      return;
    }
    finish(response.accepted === true ? 0 : 1, response);
  });
});

function finish(code, result) {
  clearTimeout(timer);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  socket.destroy();
  process.exit(code);
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = FLAGS.get(args[index]);
    const value = args[index + 1];
    if (key === undefined || typeof value !== "string" || Object.hasOwn(parsed, key)) usage();
    parsed[key] = value;
  }
  const ok = typeof parsed.socket === "string" && path.isAbsolute(parsed.socket)
    && /^[0-9a-f]{64}$/.test(parsed.nonce ?? "")
    && typeof parsed.messageId === "string" && parsed.messageId !== ""
    && MESSAGE_KINDS.has(parsed.kind)
    && typeof parsed.subject === "string" && parsed.subject !== ""
    && typeof parsed.body === "string" && parsed.body !== ""
    && (parsed.inReplyTo === undefined || parsed.inReplyTo !== "");
  if (!ok) usage();
  return parsed;
}

function usage() {
  process.stderr.write("usage: claude-channel-capture-client.mjs --socket <absolute path> "
    + "--nonce <hex> --message-id <id> --kind <question|request|answer|decision|handoff|note> "
    + "--subject <text> --body <text> [--in-reply-to <id>]\n");
  process.exit(2);
}
