export const ORIGIN = "https://getacc.dev";
export const REPOSITORY = "https://github.com/automatis-tools/agents-can-communicate";
export const SOURCE_REVISION = "8bfb53f35d8692fdc5f02adf947b69eb26a68294";
export const REVIEW_DATE = "2026-10-21";

export const sections = [
  { id: "guides", label: "Guides", title: "Make the next exchange useful.",
    description: "Practical guides to connecting independent AI coding sessions, exchanging reviews, and continuing work across clients.",
    intro: "Start with one question and one useful answer. Build a working routine from there." },
  { id: "integrations", label: "Integrations", title: "Keep the clients you like.",
    description: "ACC integration guides for Claude Code, Codex, Antigravity, Kimi Code, Gemini CLI, and Grok Build.",
    intro: "Each client has its own permissions, hooks, and way of receiving a message. Find the details for yours." },
  { id: "compare", label: "Comparisons", title: "Find the right kind of connection.",
    description: "Documentation-based comparisons of ACC, agent mailboxes, terminal tools, native messaging, and delegation plugins.",
    intro: "Start with the workflow you want to keep. These source-based comparisons explain the trade-offs, without a synthetic score." },
  { id: "research", label: "Research", title: "Look a little closer.",
    description: "Research notes on independent coding agents, message delivery, context, and the boundaries of local coordination.",
    intro: "Questions worth slowing down for. Clear distinctions, primary sources, and room for uncertainty." },
  { id: "reports", label: "Reports", title: "Show the working.",
    description: "Engineering reports on how ACC is tested, how measurements are made, and what the available evidence establishes.",
    intro: "Methods and evidence behind the software. Every conclusion should have a boundary you can inspect." },
  { id: "docs", label: "Docs", title: "A good place to begin.",
    description: "Install Agents Can Communicate, understand its local communication model, and find the ACC CLI, protocol, and client references.",
    intro: "Install ACC, open your clients, and give each session its ordinary work. The reference is here when you need it." },
];

export const sectionFor = id => sections.find(section => section.id === id);
export const sectionForType = type => ({
  guide: "guides", integration: "integrations", comparison: "compare",
  "comparison-hub": "compare", research: "research", report: "reports",
  doc: "docs", reference: "docs",
})[type];

export function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function plainText(value) {
  return String(value).replace(/<[^>]*>/g, "").replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'").replace(/\s+/g, " ").trim();
}

export const readableDate = value => new Intl.DateTimeFormat("en", {
  year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
}).format(new Date(value + "T00:00:00Z"));
