export const guideDetails = {
  "code-review-between-ai-clients": ["Review a change", "Bring another session into a specific review, then return the findings to the author."],
  "ai-agents-git-worktrees": ["Build in parallel", "Keep separate checkouts and agree on the interface between them."],
  "handoff-after-rate-limit": ["Continue in another client", "Carry the decisions, unfinished work, and checks into the next session."],
  "message-delivery": ["Understand delivery", "Know what to expect when the other session is busy, idle, or offline."],
};

export const clientDetails = {
  "claude-code": { name: "Claude Code", surface: "Terminal and local Code sessions", note: "Hooks introduce peers and bring messages into a normal turn." },
  codex: { name: "Codex", surface: "CLI and documented app surfaces", note: "Connect independent sessions while keeping each session’s context." },
  antigravity: { name: "Antigravity", surface: "CLI and desktop", note: "Follow the setup for the surface you actually use." },
  "kimi-code": { name: "Kimi Code", surface: "Terminal", note: "Keep the client’s normal turn and its own provider access." },
  "gemini-cli": { name: "Gemini CLI", surface: "Terminal", note: "Use the client’s hooks for ordinary next-turn coordination." },
  "grok-build": { name: "Grok Build", surface: "Explicit inbox access", note: "Read and answer through the durable ACC inbox." },
};

export const comparisonDetails = {
  "acc-vs-codex-plugin": ["The official Codex plugin", "Delegate inside Claude Code, or connect sessions opened independently?", "Delegation"],
  "acc-vs-hcom": ["hcom", "How much terminal automation belongs in your communication layer?", "Terminal workflow"],
  "acc-vs-mcp-agent-mail": ["MCP Agent Mail", "Does your workflow need a shared mailbox or a conversation between sessions?", "Mailbox"],
  "acc-vs-concord-mcp": ["Concord MCP", "Do you want messages alone, or an explicit model of work state?", "Work state"],
};

export const reportDetails = {
  "installed-artifact": {
    topic: "Package verification", question: "Does the installed package do what the source tests claim?",
    method: "Install the exact archive in an isolated consumer; run the commands and check restoration.",
    boundary: "A passing source-tree test alone does not establish an installable package.",
  },
  "measuring-hook-cost": {
    topic: "Performance methodology", question: "What changed in a hook’s cost, with the job held constant?",
    method: "Keep the workload and environment explicit; compare repeated runs and retain the raw evidence.",
    boundary: "A synthetic measurement is not a universal latency promise.",
  },
};

export const referenceLinks = [
  ["CLI commands", "CLI.md", "Flags, responses, and everyday operations."],
  ["Configuration", "CONFIGURATION.md", "Local settings and their defaults."],
  ["Protocol", "PROTOCOL.md", "Messages, receipts, and delivery facts."],
  ["Architecture", "ARCHITECTURE.md", "Package boundaries and the local data model."],
  ["Troubleshooting", "TROUBLESHOOTING.md", "Diagnose installation and delivery problems."],
  ["Security model", "SECURITY_MODEL.md", "Permissions, trust, and local boundaries."],
];
