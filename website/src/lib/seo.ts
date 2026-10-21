import { ORIGIN, REPOSITORY } from "../data/site";
import type { SitePage } from "./types";

export function structuredData(page: SitePage): string {
  const canonical = ORIGIN + page.route;
  const graph: Record<string, unknown>[] = [
    { "@type": "WebSite", "@id": ORIGIN + "/#website", url: ORIGIN + "/", name: "Agents Can Communicate", alternateName: "ACC" },
    { "@type": "WebPage", "@id": canonical, url: canonical, name: page.title, description: page.description,
      isPartOf: { "@id": ORIGIN + "/#website" }, inLanguage: "en",
      ...(page.article ? { lastReviewed: page.article.lastVerified } : {}) },
  ];
  if (page.kind === "home") graph.push({
    "@type": ["SoftwareApplication", "SoftwareSourceCode"], name: "Agents Can Communicate", alternateName: "ACC",
    url: ORIGIN + "/", applicationCategory: "DeveloperApplication", operatingSystem: "macOS, Linux, Windows",
    isAccessibleForFree: true, codeRepository: REPOSITORY, license: REPOSITORY + "/blob/main/LICENSE",
  });
  if (page.article) graph.push({
    "@type": "TechArticle", headline: page.article.title, description: page.description,
    mainEntityOfPage: canonical,
    author: { "@type": "Organization", name: page.article.author, url: ORIGIN + "/" },
  });
  if (page.breadcrumbs?.length) graph.push({
    "@type": "BreadcrumbList", itemListElement: [{ label: "Home", route: "/" }, ...page.breadcrumbs]
      .map((item, index) => ({ "@type": "ListItem", position: index + 1, name: item.label,
        item: ORIGIN + (item.route ?? page.route) })),
  });
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replaceAll("<", "\\u003c");
}
