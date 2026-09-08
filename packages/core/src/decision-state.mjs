// Lifecycle is a read model of explicit peer assertions, never a timestamp
// winner or a consensus verdict. Iterative traversal avoids recursion limits.
export function decisionView(messages) {
  const decisions = new Map(messages.filter(m => m.kind === "decision").map(m => [m.messageId, m]));
  const neighbours = new Map([...decisions.keys()].map(id => [id, new Set()]));
  const replaced = new Set();
  for (const message of decisions.values()) {
    for (const target of message.decisionChange?.messageIds ?? []) {
      if (!decisions.has(target)) continue;
      neighbours.get(target).add(message.messageId);
      neighbours.get(message.messageId).add(target);
      replaced.add(target);
    }
  }
  const statuses = new Map();
  for (const start of decisions.keys()) {
    if (statuses.has(start)) continue;
    const group = new Set([start]), pending = [start];
    while (pending.length > 0) {
      for (const id of neighbours.get(pending.pop())) {
        if (!group.has(id)) { group.add(id); pending.push(id); }
      }
    }
    const heads = [...group].filter(id => !replaced.has(id));
    const hasDecision = heads.some(id => decisions.get(id).decisionChange?.action !== "withdraw");
    const roots = [...group].filter(id => decisions.get(id).decisionChange === undefined);
    const groupId = (roots.length > 0 ? roots : [...group]).sort()[0];
    for (const id of group) {
      const isHead = !replaced.has(id);
      statuses.set(id, {
        state: isHead ? (decisions.get(id).decisionChange?.action === "withdraw" ? "withdrawn" : "current")
          : (hasDecision ? "superseded" : "withdrawn"),
        isHead, conflicted: heads.length !== 1, headCount: heads.length,
        currentMessageId: heads.length === 1 ? heads[0] : null, groupId,
      });
    }
  }
  return message => statuses.has(message.messageId)
    ? { ...message, decisionStatus: statuses.get(message.messageId) } : message;
}

export const isCurrentDecision = message => message.decisionStatus?.isHead !== false;
