# Website architecture

The website compiles reusable Astro components into static HTML. The build tool
lives in a private website package. ACC's runtime package and adapters remain
independent of the website build dependencies.

Content comes only from the reviewed website/content collection. The existing
frontmatter validator and safe Markdown renderer define the content boundary.
Components receive typed article/page data. Sanitized Markdown bodies are content
fragments; page frames and layouts are native Astro components.

One shared layout owns metadata, navigation, footer and progressive scripts.
Shared components own install commands, illustrations, article review details,
contents and manuscript sections. Six index structures and six reading families
remain separate compositions inside the shared brand system.

The build stages output before publication. Rendered contracts verify complete
routes, shared elements, one H1, manuscript text/anchors and internal links/assets.
An invalid build must leave the previous owned output intact. Custom destinations
must be empty or carry the builder's ownership marker; source trees are protected.

HTML remains complete without JavaScript. Search filtering, code copying and
native menu/contents behavior are progressive enhancements. No SPA router or
hydrated application shell is needed. Search, sitemap, feed and optional Markdown
navigation come from the same reviewed data rather than a parallel content copy.

Deployment and domain changes are separate operations. The Pages worker keeps
getacc.dev canonical and redirects mirror/www aliases while preserving paths and
queries. Local/preview hosts stay noindex.
