# ACC website design

## Outcome and authority

Build a distinctive, light-only, English website for Agents Can Communicate at
https://getacc.dev. The user delegates design, stack, structure, and implementation
decisions; subjective feedback follows a working browser presentation. Do not ask
for document review or intermediate approval. Create a verified draft PR; do not
merge, mark ready, publish, or change DNS.

## Product truth

ACC connects independently opened local coding sessions. Each retains its own
client, model, context, permissions, and lifecycle. It carries questions, replies,
reviews, and explicit handoffs. It does not launch workers or assign tasks.
Next-turn, polling, and opted-in experimental live delivery remain distinct.
Illustrative exchanges must be labelled as examples.

## Content findings

- .analysis contains reproducible probes, mutation controls, historical measurements,
  tooling, and source snapshots. Measurements retain revision and conditions.
- .docs is an internal archive. Some older comparisons describe removed coordinator,
  workstream, and task concepts; none may be silently republished as current truth.
- reports contains a private strategic cmux/YC report, unsuitable for an automatic
  public import. It informs the connector positioning, not public founder claims.
- research_notes contains strategic research plus 17 website manuscripts: five
  guides, six integration pages, a compatibility reference, and five comparisons.
  They distinguish documentation review from live testing.
- Import only deliberately reviewed manuscripts into website/content. Never scan
  ignored archives at build time. Preserve source links and review provenance.

## Visual contract

The idea is an open line between independent clients. The homepage leads with
an authored example conversation, a clear installation action, and restrained
typography. Reading surfaces emphasize comprehension and navigation.

- White: #FFFFFF; soft paper: #F4F7F5; ink: #192C29; secondary: #53645F;
  blue: #284BCC; reply paper: #F2F5DC.
- Newsreader display type and Public Sans body type, self-hosted with licenses.
- Left-aligned copy, asymmetric hero, intentional line lengths and generous gaps.
- Only light surfaces, including code, demos, navigation, and footer. No theme
  selector, dark media query, or OS-driven theme.
- No generic feature-card grid, decorative gradients, invented metrics,
  testimonials, stock pictures, or ornamental monospace labels.
- Motion responds to actions and respects reduced motion. All meaningful content
  and navigation work without animation or client-side rendering.

## Information architecture

Homepage; Docs; Guides; Integrations; Compatibility; Comparisons; Research; Reports;
Search; and a real 404. Every collection has useful introductory copy, real
articles, contextual cross-links, and a route-specific description.
Guides answer practical questions. Integrations describe client-specific limits.
Comparisons disclose documentation-based methodology. Research explains concepts.
Reports describe evidence and measurement methods without invented results.

Article templates support title, description, author, language, review date,
ACC version, evidence level, tags, sources, headings, tables, code, and related
reading. No fabricated publication date or hands-on testing badge.

## Build and behavior

Small Node ESM static generator. Marked 18.1.1 is an exact build-only development
dependency; the ACC runtime and the browser acquire no framework dependency.
Content has constrained JSON-value frontmatter, reviewed Markdown, and strict
safe-link handling. Raw HTML is escaped. Duplicate routes and malformed metadata
fail the build. Site tests belong to the existing complete test discovery.

Native, progressively enhanced navigation; copyable install commands; searchable
content; anchor navigation and keyboard focus; responsive reading tables and code.
The preview server binds loopback and serves exact static files with real 404s.

## SEO and hosting

Complete HTML per route, unique titles/descriptions, one H1, self-canonical URLs,
Open Graph/Twitter metadata and a real PNG share image, valid structured data,
breadcrumbs, crawlable internal links, robots, sitemap, and an Atom feed.
Search/404 are noindex and absent from sitemap/feed. Asset URLs resolve.

Prepare a standard Cloudflare Pages static artifact with an advanced-mode worker
that permanently redirects getacc.app and www variants to https://getacc.dev,
preserving path and query. Preview hosts carry noindex response headers.
Hosting deployment and actual domain routing are not claimed until performed.

## Acceptance

Prove content/SEO validation with a deliberate broken canonical mutation and
restore it. Exercise generated routes, link fragments, metadata, Markdown safety,
redirect preservation, missing paths and preview headers. Inspect desktop and
mobile browser views, keyboard navigation, copy feedback, search and no-results.
Run syntax, the full repository suite, npm pack, and installed-package verification.
Show the working local site before draft PR creation. Keep preview running for
the user; remove only superseded task-owned scratch materials.
