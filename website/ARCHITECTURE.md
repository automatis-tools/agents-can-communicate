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

The homepage recording is curated from matching native sender/receiver receipts.
src/data/recording.json supplies both the static transcript component and a
prerendered JSON download. Its public schema rejects native owner context and
credentials before output promotion. Raw capture evidence stays private; this
record demonstrates one explicit-inbox exchange, not a comparative benchmark.

The scene animates selected delivery facts with explicitly shortened timing; the
source timestamps remain unchanged. Its single-timer loop suspends with remaining time when leaving view or
backgrounding, respects a user pause, and cancels playback on manual steps or
reduced-motion changes. The shared header
uses the pinned, licensed GitHub Buttons script from local assets. The widget
loads its public count from GitHub and retains an ordinary repository link as its
progressive fallback. No ACC runtime dependency is added.

Nine curated workflow examples join the captured-message example as a safely
serialized inline JSON collection. Initial HTML retains the captured transcript;
progressive script chooses one coherent scenario and two distinct terminal styles
per page load. Another example changes the selected conversation without mixing
participants or messages. Guide destinations are checked against reviewed routes
at build time. The visible-transcript guard excludes script data, so a JSON copy
cannot conceal a missing no-JavaScript answer.

The ten examples cover message/reply, review requests, claim/release, shared intent,
decision acknowledgement and handoff. Each defines command labels, step names and
an outcome. Nine beats separate terminal focus, streamed text, completion emphasis and
command flight on both sides before the outcome pause. One cancellable timer
handles both typing ticks and phase transitions; duration follows message length.

A shuffled deck covers all ten stories before any repeat, including across
automatic cycles and manual advances. A new story redraws both OS and palette
pairs without reusing either terminal's previous skin. Story replacement occurs
only after the reading/emphasis/flights/outcome sequence has completed.
