const illustratedArticles = new Map([
  ["/guides/connect-ai-coding-sessions/", "guides"],
  ["/integrations/codex/", "integrations"],
  ["/compare/agent-communication-tools/", "compare"],
  ["/research/independent-sessions/", "research"],
  ["/reports/installed-artifact/", "reports"],
  ["/docs/install/", "docs"],
]);

export function sectionIllustration(section, className = "section-illustration") {
  return '<figure class="' + className + '" aria-hidden="true"><img src="/assets/illustrations/'
    + section + '.webp" width="512" height="512" alt="" loading="lazy" decoding="async"></figure>';
}

export function articleIllustration(article, className = "article-illustration") {
  const section = illustratedArticles.get(article.route);
  return section ? sectionIllustration(section, className) : "";
}
