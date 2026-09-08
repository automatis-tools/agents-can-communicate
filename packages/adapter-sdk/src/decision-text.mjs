// This is attribution inside peer content. It reports recorded links, never
// elevates a decision to system authority or claims that peers reached agreement.
export function decisionLines(message) {
  if (message.kind !== "decision") return [];
  const lines = [];
  if (message.decisionChange !== undefined) {
    lines.push(`Decision change: ${message.decisionChange.action} ${message.decisionChange.messageIds.join(", ")}`);
  }
  if (message.decisionStatus !== undefined) {
    const status = message.decisionStatus;
    lines.push(`Decision status: ${status.state}`
      + (status.conflicted ? `; conflicting heads: ${status.headCount}` : ""));
  }
  return lines;
}

export function decisionBody(message) {
  return [...decisionLines(message), message.body ?? ""].join("\n");
}
