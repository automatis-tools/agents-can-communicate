import { escapeHtml as e, readableDate } from "./config.mjs";
import { articleIllustration } from "./illustrations.mjs";
import { clientDetails } from "./collection-details.mjs";

function contents(article, label = "On this page") {
  return '<nav class="reading-outline" aria-label="' + e(label) + '"><h2>' + e(label) + '</h2><ol>'
    + article.sections.map(section => '<li><a href="#' + e(section.id) + '">' + e(section.text) + '</a></li>').join("")
    + "</ol></nav>";
}

function expandableContents(article, label) {
  return '<details class="reading-contents"><summary>' + e(label) + '</summary>' + contents(article, label) + '</details>';
}

function method(article) {
  return article.evidenceLevel === "documentation-comparison"
    ? "A comparison of primary documentation, without a head-to-head client test."
    : article.evidenceLevel.endsWith("-method")
      ? "An engineering method, with its scope and evidence sources stated below."
      : "Reviewed against the documentation and recorded evidence for ACC " + article.accVersion + ".";
}

function review(article) {
  return '<span>By ' + e(article.author) + '</span><span>Sources reviewed <time datetime="' + article.lastVerified + '">'
    + readableDate(article.lastVerified) + '</time></span><span>' + article.minutes + ' min read</span>';
}

function heading(article) {
  return '<h1>' + e(article.title) + '</h1><p class="article-deck">' + e(article.description) + '</p>';
}

function manuscript(article) {
  return '<!-- manuscript:start --><div class="article-intro prose">' + article.introHtml + '</div><div class="article-sections">'
    + article.sections.map(section => '<section class="article-section prose' + (section.hasTable ? " has-table" : "")
      + (section.id === "sources" ? " is-sources" : "") + '" aria-labelledby="' + e(section.id) + '">'
      + section.headingHtml + '<div class="section-content">' + section.bodyHtml + '</div></section>').join("")
    + '</div><!-- manuscript:end -->';
}

function guide(article) {
  return '<header class="guide-article-heading">' + heading(article)
    + '<div class="article-review">' + review(article) + '</div></header><div class="guide-reading-workspace">'
    + '<aside class="guide-reading-rail">' + contents(article, "In this guide")
    + '<p class="method-note">' + e(method(article)) + '</p><a href="/guides/">All guides</a>' + articleIllustration(article, "article-illustration guide-rail-art") + '</aside>'
    + '<div class="guide-manuscript"><div class="guide-mobile-contents">' + expandableContents(article, "In this guide") + '</div>'
    + manuscript(article) + articleIllustration(article, "article-illustration guide-mobile-art") + '<p class="guide-mobile-method method-note">' + e(method(article)) + '</p></div></div>';
}

function integration(article) {
  const client = clientDetails[article.id] ?? { name: "Coding client", surface: "ACC integration" };
  return '<header class="setup-heading"><div class="setup-identity"><strong>'
    + e(client.name) + '</strong><span>' + e(client.surface) + '</span>' + articleIllustration(article, "article-illustration integration-art") + '</div><div class="setup-title">' + heading(article)
    + '<div class="article-review">' + review(article) + '</div></div></header><div class="setup-toolbar">'
    + expandableContents(article, "Setup and usage") + '<a href="/compatibility/">Delivery and compatibility</a></div>'
    + '<div class="setup-manuscript">' + manuscript(article) + '</div><p class="setup-method method-note">'
    + e(method(article)) + '</p>';
}

function comparison(article) {
  return '<header class="decision-heading"><div>' + heading(article)
    + '<div class="article-review">' + review(article) + '</div></div></header>'
    + '<div class="decision-method">' + articleIllustration(article, "article-illustration comparison-art") + '<span>Method</span><p>' + e(method(article)) + '</p></div>'
    + expandableContents(article, "Questions in this comparison") + '<div class="decision-manuscript">' + manuscript(article) + '</div>';
}

function research(article) {
  return '<header class="essay-heading">' + heading(article) + '</header>'
    + '<div class="essay-workspace"><aside class="essay-margin"><div class="article-review">' + review(article)
    + '</div><p class="method-note">' + e(method(article)) + '</p>' + expandableContents(article, "In this essay")
    + articleIllustration(article, "article-illustration research-art") + '</aside><div class="essay-manuscript">' + manuscript(article) + '</div></div>';
}

function report(article) {
  return '<div class="report-reading-workspace"><div class="report-paper"><header class="report-paper-heading">'
    + heading(article)
    + '</header>' + manuscript(article) + '</div><aside class="report-record"><h2>Record</h2>' + articleIllustration(article, "article-illustration report-art") + '<dl><dt>Author</dt><dd>'
    + e(article.author) + '</dd><dt>Sources reviewed</dt><dd><time datetime="' + article.lastVerified + '">'
    + readableDate(article.lastVerified) + '</time></dd><dt>ACC version</dt><dd>' + e(article.accVersion)
    + '</dd><dt>Reading time</dt><dd>' + article.minutes + ' minutes</dd></dl>' + contents(article, "Report contents")
    + '<p class="method-note">' + e(method(article)) + '</p><a href="/reports/">Engineering register</a></aside></div>';
}

function documentation(article, articles) {
  const neighbours = articles.filter(item => item.section === "docs").sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  return '<div class="reference-workspace"><aside class="reference-sidebar"><a class="reference-home" href="/docs/">Documentation</a>'
    + '<nav aria-label="Documentation pages">' + neighbours.map(item => '<a href="' + e(item.route) + '"'
      + (item.route === article.route ? ' aria-current="page"' : "") + '>'
      + e(item.id === "supported-clients-and-delivery" ? "Clients and delivery" : item.title) + '</a>').join("") + '</nav>'
    + contents(article) + '<a class="reference-search" href="/search/">Search the library</a>' + articleIllustration(article, "article-illustration docs-rail-art") + '</aside>'
    + '<div class="reference-manuscript"><header class="reference-heading">' + heading(article) + '</header>'
    + '<div class="reference-mobile-contents">' + expandableContents(article, "On this page") + '</div>'
    + manuscript(article) + articleIllustration(article, "article-illustration docs-mobile-art") + '<footer class="reference-revision"><div class="article-review">' + review(article)
    + '</div><p class="method-note">' + e(method(article)) + '</p></footer></div></div>';
}

const layouts = {
  guide: ["guide", guide], integration: ["integration", integration],
  comparison: ["comparison", comparison], "comparison-hub": ["comparison comparison-overview", comparison],
  research: ["research", research], report: ["report", report],
  doc: ["doc", documentation], reference: ["reference", documentation],
};

export function renderArticle(article, articles) {
  const selected = layouts[article.type];
  if (!selected) throw new Error("no article layout for type: " + article.type);
  return { className: selected[0].split(" ").map(name => "article-" + name).join(" "),
    html: selected[1](article, articles) };
}
