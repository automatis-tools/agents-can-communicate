import { ORIGIN, REPOSITORY, escapeHtml as e, sections } from "./config.mjs";

export function icon(name) {
  const paths = {
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    arrow: '<path d="M4 12h15M13 6l6 6-6 6"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
    github: '<path d="M8 20c-4 1-4-2-6-2m12 4v-4a3.5 3.5 0 0 0-1-2.7c3.3-.4 6.8-1.6 6.8-7A5.5 5.5 0 0 0 18.3 4c.2-.9.2-2.3-.2-3.3 0 0-1.3-.4-4.1 1.5a14 14 0 0 0-7.4 0C3.8.3 2.5.7 2.5.7 2.1 1.7 2.1 3.1 2.3 4A5.5 5.5 0 0 0 .8 8.3c0 5.4 3.5 6.6 6.8 7A3.5 3.5 0 0 0 6.6 18v4"/>',
  };
  return '<svg class="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" '
    + 'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" '
    + 'aria-hidden="true">' + paths[name] + "</svg>";
}

function navLinks(current, ids) {
  return sections.filter(section => !ids || ids.includes(section.id)).map(section => '<a href="/' + section.id + '/"'
    + (current === section.id ? ' aria-current="page"' : "") + ">" + section.label + "</a>").join("");
}

function header(section) {
  return '<a class="skip-link" href="#main">Skip to content</a><header class="site-header shell">'
    + '<a class="brand" href="/" title="ACC home">'
    + '<img class="brand-symbol" src="/assets/acc-mark.svg" alt="" width="52" height="34">'
    + '<span class="wordmark">ACC</span>'
    + '<span class="brand-name">Agents Can Communicate</span></a>'
    + '<nav class="desktop-nav" aria-label="Main">' + navLinks(section, ["guides", "integrations", "docs"])
    + '<details class="reading-menu"><summary>Reading</summary><nav aria-label="Reading">'
    + navLinks(section, ["compare", "research", "reports"]) + '</nav></details></nav>'
    + '<div class="header-actions"><a class="search-link" href="/search/" aria-label="Search the site">'
    + icon("search") + '</a><a class="github-link" href="' + REPOSITORY + '">GitHub</a>'
    + '<details class="mobile-nav"><summary>Menu</summary><nav aria-label="Mobile">'
    + navLinks(section) + '<a href="' + REPOSITORY + '">GitHub</a></nav></details></div></header>';
}

function footer() {
  return '<footer class="site-footer shell"><nav class="footer-links" aria-label="Footer">' + navLinks()
    + '<a href="/compatibility/">Compatibility</a><a href="/feed.xml">Feed</a></nav>'
    + '<div class="footer-note"><span>ACC is open source, MIT licensed. By Mykola Maksymenko.</span>'
    + '<span><a href="' + REPOSITORY + '">Source</a> · <a href="' + REPOSITORY + '/issues">Issues</a> · <a href="'
    + REPOSITORY + '/blob/main/SECURITY.md">Security</a></span></div></footer>';
}

export function breadcrumbs(items) {
  return '<nav class="breadcrumbs" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li>'
    + items.map(item => "<li>" + (item.route ? '<a href="' + e(item.route) + '">'
      + e(item.label) + "</a>" : '<span aria-current="page">' + e(item.label) + "</span>") + "</li>").join("")
    + "</ol></nav>";
}

export function layout(page, body) {
  const canonical = ORIGIN + page.route;
  const graph = [{ "@type": "WebSite", "@id": ORIGIN + "/#website", url: ORIGIN + "/",
    name: "Agents Can Communicate", alternateName: "ACC" },
  { "@type": "WebPage", "@id": canonical, url: canonical, name: page.title,
    description: page.description, isPartOf: { "@id": ORIGIN + "/#website" }, inLanguage: "en" }];
  if (page.route === "/") graph.push({
    "@type": ["SoftwareApplication", "SoftwareSourceCode"], name: "Agents Can Communicate",
    alternateName: "ACC", url: ORIGIN + "/", applicationCategory: "DeveloperApplication",
    operatingSystem: "macOS, Linux, Windows", isAccessibleForFree: true,
    codeRepository: REPOSITORY, license: REPOSITORY + "/blob/main/LICENSE",
  });
  if (page.article) graph.push({ "@type": "TechArticle", headline: page.article.title,
    description: page.description, mainEntityOfPage: canonical, dateModified: page.article.lastVerified,
    author: { "@type": "Organization", name: "ACC project", url: ORIGIN + "/" } });
  if (page.breadcrumbs?.length) graph.push({ "@type": "BreadcrumbList",
    itemListElement: [{ label: "Home", route: "/" }, ...page.breadcrumbs].map((item, index) => ({
      "@type": "ListItem", position: index + 1, name: item.label,
      item: ORIGIN + (item.route ?? page.route),
    })) });
  const schema = JSON.stringify({ "@context": "https://schema.org", "@graph": graph })
    .replaceAll("<", "\\u003c");
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="color-scheme" content="light"><meta name="theme-color" content="#ffffff">'
    + "<title>" + e(page.title) + "</title>"
    + '<meta name="description" content="' + e(page.description) + '">'
    + '<meta name="robots" content="' + (page.noindex ? "noindex,follow" : "index,follow") + '">'
    + '<link rel="canonical" href="' + canonical + '">'
    + '<meta property="og:type" content="' + (page.article ? "article" : "website") + '">'
    + '<meta property="og:site_name" content="Agents Can Communicate">'
    + '<meta property="og:title" content="' + e(page.title) + '">'
    + '<meta property="og:description" content="' + e(page.description) + '">'
    + '<meta property="og:url" content="' + canonical + '">'
    + '<meta property="og:image" content="' + ORIGIN + '/assets/social-card.png">'
    + '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">'
    + '<meta property="og:image:alt" content="ACC connects independent AI coding sessions.">'
    + '<meta name="twitter:card" content="summary_large_image">'
    + '<meta name="twitter:title" content="' + e(page.title) + '">'
    + '<meta name="twitter:description" content="' + e(page.description) + '">'
    + '<meta name="twitter:image" content="' + ORIGIN + '/assets/social-card.png">'
    + '<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">'
    + '<link rel="alternate" type="application/atom+xml" title="ACC articles" href="/feed.xml">'
    + '<link rel="preload" href="/assets/fonts/public-sans-latin.woff2" as="font" type="font/woff2" crossorigin>'
    + '<link rel="stylesheet" href="/assets/base.css"><link rel="stylesheet" href="/assets/'
    + (page.route === "/" ? "home" : "reading") + '.css">'
    + (page.collection ? '<link rel="stylesheet" href="/assets/collections.css">' : "")
    + (page.article ? '<link rel="stylesheet" href="/assets/articles.css">' : "")
    + '<script type="application/ld+json">' + schema + "</script>"
    + '<script type="module" src="/assets/site.mjs"></script></head><body>'
    + header(page.section) + '<main id="main" class="' + (page.route === "/" ? "home" : "shell reading-main")
    + '" tabindex="-1">' + body + "</main>" + footer() + "</body></html>\n";
}
