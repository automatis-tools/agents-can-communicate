import { randomUUID } from "node:crypto";

import { describeAttachment, verifyAttachment } from "./attachments.mjs";
import { writeJsonAtomic } from "./atomic-json.mjs";
import { CommsError, EXIT } from "./errors.mjs";
import { sendMessage } from "./messages.mjs";
import { validateHandoff } from "./schema.mjs";

function handoffId(context, input, timestamp) {
  const uuid = (context.randomUUID ?? randomUUID)();
  return `handoff-${timestamp.replaceAll("-", "").replaceAll(":", "")}-${input.from}-${input.to}-${uuid}`;
}

function handoffInput(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new CommsError("handoff input must be an object", EXIT.DATA, { input });
  }
  return input;
}

async function canonicalArtifacts(context, artifacts) {
  if (!Array.isArray(artifacts)) return artifacts;
  return Promise.all(artifacts.map(async artifact => {
    await verifyAttachment(context, artifact);
    return describeAttachment(context, artifact);
  }));
}

function readiness(uncommitted, verification) {
  const failed = Array.isArray(verification)
    && verification.some(entry => entry?.exitCode !== 0);
  if (uncommitted === true) return { ready: false, state: "UNCOMMITTED" };
  return failed ? { ready: false, state: "NOT_READY" } : { ready: true, state: "READY" };
}

function buildHandoff(context, input, artifacts) {
  const timestamp = context.now().toISOString();
  const status = readiness(input.uncommitted, input.verification);
  return {
    schema_version: 1,
    id: handoffId(context, input, timestamp),
    from: input.from,
    to: input.to,
    task: input.task,
    result: input.result,
    branch: input.branch,
    commit: input.commit,
    base: input.base,
    changed_paths: input.changedPaths,
    verification: input.verification,
    contracts: input.contracts,
    follow_up: input.followUp,
    artifacts,
    limitations: input.limitations,
    uncommitted: input.uncommitted,
    ready_to_merge: status.ready,
    state: status.state,
    created_at: timestamp,
  };
}

function verificationSummary(verification) {
  return verification.map(entry => `- ${entry.command}: exit ${entry.exitCode} (${entry.summary})`)
    .join("\n");
}

function limitationsSummary(limitations) {
  return limitations.length === 0 ? "- none" : limitations.map(item => `- ${item}`).join("\n");
}

function handoffMessage(record) {
  const commit = record.commit === null ? "none" : record.commit;
  const commitState = record.uncommitted
    ? `Commit state: ${record.state} (${commit}; never ready to merge)`
    : `Commit state: ${record.state} (${commit})`;
  return {
    from: record.from,
    to: record.to,
    type: "handoff",
    severity: "action",
    subject: `Handoff ${record.task}: ${record.state}`,
    body: [
      `Handoff record: ${record.id}`,
      `Result: ${record.result}`,
      commitState,
      `Base: ${record.base}`,
      "Verification:",
      verificationSummary(record.verification),
      "Limitations:",
      limitationsSummary(record.limitations),
    ].join("\n"),
    task: record.task,
    requiresAck: true,
    attachments: record.artifacts,
  };
}

export async function createHandoff(context, input) {
  const source = handoffInput(input);
  const artifacts = await canonicalArtifacts(context, source.artifacts);
  const record = validateHandoff(buildHandoff(context, source, artifacts));
  await writeJsonAtomic(context.paths.handoffFile(record.id), record, {
    tmpDir: context.paths.tmp,
    exclusive: true,
  });
  const message = await sendMessage(context, handoffMessage(record));
  return { record, message };
}
