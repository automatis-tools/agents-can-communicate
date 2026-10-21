import { breadcrumbs, icon, layout } from "./layout.mjs";
import { escapeHtml as e, sectionFor } from "./config.mjs";
import { renderArticle } from "./article-layouts.mjs";
export { collectionPage } from "./collections.mjs";

export function articleLink(article) {
  const section = sectionFor(article.section);
  return '<article class="article-link">'
    + '<div class="article-link-meta"><span>' + section.label + "</span><span>"
    + article.minutes + ' min read</span></div><h2><a href="' + e(article.route) + '">'
    + e(article.title) + '</a></h2><p>' + e(article.description) + "</p>"
    + '<a class="text-link" href="' + e(article.route) + '" aria-label="Read the article: '
    + e(article.title) + '">Read the article' + icon("arrow") + "</a></article>";
}

export function articlePage(article, articles) {
  const section = sectionFor(article.section);
  const crumbs = [{ label: section.label, route: "/" + section.id + "/" }, { label: article.title }];
  const related = articles.filter(item => item.route !== article.route && item.section === article.section).slice(0, 3);
  const rendered = renderArticle(article, articles);
  return layout({ route: article.route, section: article.section, title: article.title + " | ACC",
    description: article.description, article, breadcrumbs: crumbs },
  breadcrumbs(crumbs) + '<article class="article-page ' + rendered.className + '">' + rendered.html + '</article>'
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
    noindex: true }, '<section class="not-found"><h1>404: Page not found.</h1>'
    + '<p>This page may have moved. Search the library or return to the homepage.</p>'
    + '<div class="actions"><a class="button" href="/search/">Search the site</a>'
    + '<a class="text-link" href="/">Return home' + icon("arrow") + "</a></div></section>");
}
