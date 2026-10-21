import { breadcrumbs, icon, layout } from "./layout.mjs";
import { escapeHtml as e, readableDate, REPOSITORY, sectionFor } from "./config.mjs";

export function articleLink(article, featured = false) {
  const section = sectionFor(article.section);
  return '<article class="article-link' + (featured ? " article-featured" : "") + '">'
    + '<div class="article-link-meta"><span>' + section.label + "</span><span>"
    + article.minutes + ' min read</span></div><h2><a href="' + e(article.route) + '">'
    + e(article.title) + '</a></h2><p>' + e(article.description) + "</p>"
    + '<a class="text-link" href="' + e(article.route) + '" aria-label="Read the article: '
    + e(article.title) + '">Read the article' + icon("arrow") + "</a></article>";
}

export function collectionPage(section, articles) {
  const sorted = articles.filter(article => article.section === section.id)
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.title.localeCompare(b.title));
  const extra = section.id !== "docs" ? "" : '<section class="reference-links"><h2>Keep the reference close.</h2>'
    + '<p>The complete technical documentation lives with the source. These links open the current repository reference.</p>'
    + '<div><a href="' + REPOSITORY + '/blob/main/docs/CLI.md">CLI commands</a><a href="'
    + REPOSITORY + '/blob/main/docs/CONFIGURATION.md">Configuration</a><a href="' + REPOSITORY
    + '/blob/main/docs/PROTOCOL.md">Protocol</a><a href="' + REPOSITORY
    + '/blob/main/docs/ARCHITECTURE.md">Architecture</a><a href="' + REPOSITORY
    + '/blob/main/docs/TROUBLESHOOTING.md">Troubleshooting</a></div></section>';
  return layout({ route: "/" + section.id + "/", section: section.id,
    title: section.label + " for AI coding sessions | ACC", description: section.description,
    breadcrumbs: [{ label: section.label }] },
  breadcrumbs([{ label: section.label }]) + '<header class="collection-header"><h1>'
    + section.label + '</h1><div><p class="collection-statement">' + section.title
    + '</p><p class="collection-intro">' + section.intro + '</p></div></header>'
    + '<section class="collection-list" aria-label="' + section.label + '">'
    + sorted.map((article, index) => articleLink(article, index === 0)).join("") + "</section>" + extra);
}

export function articlePage(article, articles) {
  const section = sectionFor(article.section);
  const crumbs = [{ label: section.label, route: "/" + section.id + "/" }, { label: article.title }];
  const related = articles.filter(item => item.route !== article.route && item.section === article.section).slice(0, 3);
  const method = article.evidenceLevel === "documentation-comparison"
    ? "A comparison of primary documentation, without a head-to-head client test."
    : article.evidenceLevel.endsWith("-method")
      ? "An engineering method, with its scope and evidence sources stated below."
      : "Reviewed against the documentation and recorded evidence for ACC " + article.accVersion + ".";
  const toc = article.headings.filter(heading => heading.depth === 2).map(heading =>
    '<li><a href="#' + heading.id + '">' + e(heading.text) + "</a></li>").join("");
  return layout({ route: article.route, section: article.section, title: article.title + " | ACC",
    description: article.description, article, breadcrumbs: crumbs },
  breadcrumbs(crumbs) + '<article class="article-page"><header class="article-header"><h1>'
    + e(article.title) + '</h1><p class="article-deck">' + e(article.description) + "</p>"
    + '<p class="article-byline">By ' + e(article.author) + '. Sources reviewed <time datetime="'
    + article.lastVerified + '">' + readableDate(article.lastVerified) + "</time>.</p>"
    + '<p class="method-note">' + e(method) + "</p></header>"
    + '<div class="article-grid"><div class="prose">' + article.html + "</div>"
    + '<aside class="article-toc"><nav aria-label="On this page"><h2>On this page</h2><ol>'
    + toc + '</ol></nav><a class="toc-install" href="/docs/install/">Install ACC' + icon("arrow")
    + '</a></aside></div></article>'
    + (related.length ? '<section class="related-reading"><h2>Keep reading.</h2><div>'
      + related.map(item => articleLink(item)).join("") + "</div></section>" : ""));
}

export function searchPage(articles) {
  return layout({ route: "/search/", title: "Search ACC guides and documentation | ACC",
    description: "Find ACC guides, integration details, comparisons, research notes, and engineering reports.",
    noindex: true },
  breadcrumbs([{ label: "Search" }]) + '<header class="search-header"><h1>Find your next answer.</h1>'
    + '<form action="/search/" method="get" role="search" data-search-form>'
    + '<label for="search-query">Search the ACC library</label><div class="search-field">'
    + '<input id="search-query" name="q" type="search" placeholder="Try handoff, Codex, or delivery" autocomplete="off">'
    + '<button type="submit" class="button">Search</button></div></form>'
    + '<p class="search-status" role="status" aria-live="polite" data-search-status>Browse all '
    + articles.length + ' articles below.</p><noscript><p>All articles are listed below. '
    + 'You can also use your browser’s Find command.</p></noscript></header>'
    + '<section class="search-results" aria-label="Search results">'
    + articles.map(article => '<div data-search-result="' + e(article.route) + '">'
      + articleLink(article) + "</div>").join("")
    + '<p class="search-empty" data-search-empty hidden>No articles match that search. '
    + 'Try a client name, “review”, or “handoff”.</p></section>');
}

export function notFoundPage() {
  return layout({ route: "/404.html", title: "Page not found | ACC",
    description: "This page is not in the ACC library. Find a guide, search the documentation, or return home.",
    noindex: true }, '<section class="not-found"><p class="error-code">404</p><h1>The line ends here.</h1>'
    + '<p>This page may have moved. The rest of the conversation is still here.</p>'
    + '<div class="actions"><a class="button" href="/search/">Search the site</a>'
    + '<a class="text-link" href="/">Return home' + icon("arrow") + "</a></div></section>");
}
