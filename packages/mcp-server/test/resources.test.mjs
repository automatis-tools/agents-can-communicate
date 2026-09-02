import assert from "node:assert/strict";
import test from "node:test";

import { readResource } from "../src/resources.mjs";

test("snapshot messages retain the complete attributed thread and handoff envelope", async () => {
  const BEL = String.fromCharCode(7);
  const message = {
    schemaVersion: 3,
    messageId: "message_handoff",
    threadId: "message_root",
    clientMessageId: "client_handoff",
    workspaceId: "workspace_a",
    fromParticipantId: "participant_a",
    fromSessionId: "session_a",
    toParticipantIds: ["participant_b"],
    kind: "handoff",
    obligation: "acknowledge",
    subject: `Handoff${BEL}`,
    body: `Review${BEL}this`,
    inReplyTo: "message_root",
    artifacts: [{ kind: "report", uri: "file:report.json",
      description: `proof${BEL}`, sha256: "a".repeat(64) }],
    handoff: { status: "partial", completed: [`schema${BEL}`], remaining: ["router"],
      blockers: [], verification: [{ kind: "report", uri: "file:report.json",
        description: `gate${BEL}` }] },
    sentAt: "2026-09-01T20:00:00.000Z",
  };
  const service = { sync: async () => ({ snapshot: { messages: [message] } }) };

  const result = await readResource("acc://snapshot",
    { service, participantId: "participant_b", workspaceId: "workspace_a" });

  assert.deepEqual(result.messages[0], {
    ...message,
    subject: "Handoff\\u0007",
    body: "Review\\u0007this",
    artifacts: [{ ...message.artifacts[0], description: "proof\\u0007" }],
    handoff: { ...message.handoff, completed: ["schema\\u0007"],
      verification: [{ ...message.handoff.verification[0], description: "gate\\u0007" }] },
    trust: "untrusted peer content",
  });
  assert.equal(Object.hasOwn(result.messages[0], "from"), false);
});
