# Search and agent discovery

Research checked against primary documentation on2026-10-21. Technical eligibility
is not a ranking, indexing or citation guarantee.

## What matters here

- Complete readable HTML, descriptive unique titles/descriptions, meaningful H1/H2
  hierarchy, crawlable links, stable URLs, relevant related reading and useful
  original material. Six collections organize22 reviewed manuscripts by intent.
- One canonical origin: getacc.dev. Mirror/www aliases redirect301 with paths and
  queries intact; preview HTML is noindex. Search and404 stay out of the sitemap.
- Native Astro components render during build. Content does not require hydration,
  browser execution or an SPA router; JS adds search, copying and menu behavior.
- Accurate WebSite/WebPage/TechArticle/BreadcrumbList and developer-software JSON-LD
  describe visible content. No invented ratings, offers, publication dates or
  modification dates. Visible review dates map to WebPage.lastReviewed. The
  sitemap omits lastmod until actual page modification metadata is maintained;
  Atom updated records the editorial review update.
- Self-hosted font, small CSS/JS, sized WebP art, lazy secondary images and priority
  hero avoid unnecessary runtime work and layout movement. Field targets are
  LCP<=2.5s, INP<200ms, CLS<0.1; local checks cannot establish field acceptance.
- Each article has an optional full index.md mirror and alternate link. Mirrors
  send text/markdown, an HTTP canonical Link to HTML, and noindex. llms.txt is a
  convenience index generated from the same reviewed records; it is not a
  documented Google requirement or a claimed ranking signal.

## Search crawlers and training

Public robots.txt allows crawling and advertises the canonical XML sitemap.
There is no bot-specific alternate content. Google Search AI features use the
usual search requirements; no special AI schema or AI text file is required.
OAI-SearchBot enables OpenAI search discovery; GPTBot is a separate training
crawler. Allowing or blocking one does not configure the other. ChatGPT-User is
user-initiated access, not the search crawler. No policy is inferred from a bot's
name; future training restrictions must preserve search access deliberately.

## Content and measurement

Publish substantive guides, accurate per-client setup, fair comparisons and
research/reports with sources, methods, version scope and limitations. Refresh
review dates only after actual review. Do not create thin keyword variants.

After production launch, verify Google Search Console and Bing Webmaster Tools,
submit the canonical sitemap, inspect rendering/index coverage and measure field
Core Web Vitals. Bing AI Performance reports citations, not classic ranking
positions. Observe impressions, qualified visits and successful installation paths;
local builds do not prove crawling, rankings or AI citations. External account
setup, submissions, DNS and deployment are outside this change.

## Primary sources

- [Google AI features](https://developers.google.com/search/docs/appearance/ai-features):
  ordinary SEO, indexing/snippet eligibility, textual content, links and matching
  structured data; no extra technical requirements or special AI files/schema.
- [Google structured data](https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data):
  truthful markup and JSON-LD; eligibility does not guarantee a rich result.
- [Google Core Web Vitals](https://developers.google.com/search/docs/appearance/core-web-vitals):
  real-world loading, responsiveness and stability targets.
- [Bing guidelines](https://www.bing.com/webmasters/help/webmaster-guidelines-30fba23a):
  discovery, canonical consistency, accessible useful content and spam avoidance.
- [Bing AI Performance](https://www.bing.com/webmasters/help/ai-performance-9f8e7d6c):
  citation visibility and measurement limits.
- [OpenAI crawler documentation](https://developers.openai.com/api/docs/bots):
  distinct search, training and user-initiated crawlers.
- [Schema.org lastReviewed](https://schema.org/lastReviewed):
  date of accuracy/completeness review on WebPage.
- [Astro components](https://docs.astro.build/en/basics/astro-components/):
  HTML rendered at build time, with no component client runtime by default.
