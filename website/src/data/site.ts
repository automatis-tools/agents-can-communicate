import { sections as sourceSections } from "../../lib/config.mjs";
import type { Article, SectionId, SiteSection } from "../lib/types";
export { ORIGIN, REPOSITORY, readableDate } from "../../lib/config.mjs";
export const sections = sourceSections as SiteSection[];
export const installCommand = "npm install -g agents-can-communicate\nacc install";
export function getSection(id: SectionId): SiteSection {
  const section = sections.find(item => item.id === id);
  if (!section) throw new Error("unknown site section: " + id);
  return section;
}
export function ordered(articles: Article[]): Article[] {
  return [...articles].sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.title.localeCompare(b.title));
}
export function method(article: Article): string {
  return article.evidenceLevel === "documentation-comparison"
    ? "A comparison of primary documentation, without a head-to-head client test."
    : article.evidenceLevel.endsWith("-method")
      ? "An engineering method, with its scope and evidence sources stated below."
      : "Reviewed against the documentation and recorded evidence for ACC " + article.accVersion + ".";
}
const illustrated: Record<string, SectionId> = {
  "/guides/connect-ai-coding-sessions/": "guides", "/integrations/codex/": "integrations",
  "/compare/agent-communication-tools/": "compare", "/research/independent-sessions/": "research",
  "/reports/installed-artifact/": "reports", "/docs/install/": "docs",
};
export const illustrationFor = (article: Article): SectionId | undefined => illustrated[article.route];
