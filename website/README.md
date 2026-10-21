# ACC website

Static, light-only Astro website for https://getacc.dev. Native components compile
to complete HTML with no client framework or SPA router. Node 24+ and exact build
dependencies live in the private website package; ACC runtime remains independent.

## Work locally

~~~bash
npm ci
npm ci --prefix website
npm run site:build
npm run site:preview
~~~

The preview listens on http://127.0.0.1:4321. Use
node website/serve.mjs --port 4179 for another port. Rebuild and refresh after
editing source; the preview reads the built files.

Generated files live in website/dist and are ignored. A custom --out directory
must be empty or contain this builder's ownership marker; the build refuses to
erase unrelated work.

## Components and build safety

src/layouts/SiteLayout.astro owns the shared frame and SEO head. Components under
src/components own navigation, commands, metadata, contents and manuscript blocks.
Home sections, six collection indexes and six article families compose those
primitives. Edit the shared component once to update every applicable page.

The builder snapshots source and reviewed data, typechecks native Astro components,
and compiles into an isolated cache/output stage. Contracts check every route,
shared frame, required homepage section, complete manuscript, heading anchor and
internal link before replacing the last good owned output. Failed builds retain it.

[Architecture](ARCHITECTURE.md), [brand](BRAND.md) and [search research](SEO.md)
record the boundaries and primary sources. Optional index.md mirrors and llms.txt
help direct readers; canonical HTML remains the search target.

## Add content

Add a Markdown file under content/guides, integrations, compare, research, reports,
docs, or reference. Builds read only this reviewed collection, never the local
.analysis, .docs, reports, research_notes, or .media archives.

Frontmatter uses JSON values on one line per key:

~~~yaml
---
id: "a-focused-question"
title: "A focused question"
description: "A useful, page-specific summary."
route: "/research/a-focused-question/"
type: "research"
order: 30
status: "reviewed"
language: "en"
author: "ACC project"
lastVerified: "2026-10-21"
accVersion: "0.11.1"
evidenceLevel: "architecture-review"
---

# A focused question
~~~

The source H1 must match the title. Types are guide, integration, comparison,
comparison-hub, research, report, doc, and reference. Lower order values lead a
collection. Routes are lowercase, descriptive, and end in a slash.

Use status draft for unpublished work. Only reviewed manuscripts enter HTML,
search, the sitemap, and the feed. Unknown statuses fail the build.

Use ordinary Markdown headings, links, lists, tables, quotes, and fenced code.
Raw HTML is escaped. Executable URLs, duplicate routes, invalid dates, malformed
metadata, and symlinked content fail the build. Images need meaningful alt text.

Every article receives complete HTML, canonical metadata, breadcrumbs, a contents
list, related reading, structured data, a search entry, sitemap coverage, and an
Atom entry. Search and 404 are noindex and excluded from the sitemap and feed.

## Editorial evidence

The first 17 manuscripts were curated from the local site-content workspace,
reviewed against ACC 0.11.1 source revision
8bfb53f35d8692fdc5f02adf947b69eb26a68294. ACC source links retain that revision.
The additional research and reports explain product boundaries and engineering
methods. They make no new benchmark, native-client, or model-quality claims.

The old archives informed the content taxonomy. Private strategy, raw logs,
runtime data, obsolete coordinator/task descriptions, and third-party research
bundles were not copied into the public collection.

Keep a review date distinct from a publication date. Do not invent a published
date or a hands-on badge. Comparisons identify documentation-based methodology.
Preserve source links and version/capture qualifications when editing.

## Hosting

Cloudflare Pages settings:

- Repository root: this checkout.
- Build command: npm ci && npm ci --prefix website && npm run site:build
- Output directory: website/dist

The build includes standalone advanced-mode _worker.js. It redirects getacc.app,
www.getacc.app, and www.getacc.dev to https://getacc.dev with the same encoded path
and query. Both domains must actually be attached to the Pages project and have
working DNS/certificates before that behavior exists publicly.

Other hosts receive X-Robots-Tag: noindex on HTML, including Pages preview domains.
getacc.dev has indexable headers. The local preview also defaults to noindex.
For a local artifact-only Lighthouse audit, createPreviewServer accepts
noindex: false; this does not change the production worker or its preview policy.

Deployment and domain attachment are separate operations. Building this repository
does not create hosting, change DNS, or publish any page.

## Checks

~~~bash
node --test tests/website.test.mjs tests/website-build.test.mjs
npm run check
npm test
npm pack
node scripts/verify-package.mjs
~~~

The website test is included in the repository's complete test discovery. It
checks the actual built HTML and assets, internal links/fragments, sitemap/feed,
metadata, safe Markdown, duplicate routes, output ownership, hosting redirects,
preview headers, and real local HTTP 404s.

Visual review also covers desktop/mobile composition, keyboard navigation,
search and no-results, copy feedback, and long article tables. Local Lighthouse
results are lab observations; they do not establish field Core Web Vitals,
search indexation, or a native phone capture.

Self-hosted font files retain their OFL licenses and download provenance.
The share image is code-authored typography and geometry.
