# ACC Website Implementation Plan

> For agentic workers: use superpowers:executing-plans inline. The user delegated
> execution choices and waived intermediate design/document approval.

**Goal:** Deliver a distinctive light-only ACC website with reviewed content and SEO.

**Architecture:** Node ESM static build from reviewed Markdown; shared page templates;
small progressive enhancement; exact static preview and optional hosting adapter.

**Tech Stack:** Node 24+, Marked 18.1.1 (development only), HTML, CSS, browser JS.

**Spec:** docs/superpowers/specs/2026-10-21-acc-website-design.md

## Global Constraints

- Canonical origin https://getacc.dev; getacc.app redirects while preserving URLs.
- Light only, without a selector or OS-driven theme.
- No runtime ACC dependencies or frontend framework.
- Production modules and focused tests stay below 300 lines.
- Preserve independent sessions, delivery boundaries and evidence provenance.
- No automatic publication of ignored archives or private strategic reports.
- The user's first review is the working browser result.
- Draft PR only; no merge, ready transition, DNS change, or deployment.

## Review Focus

- Article metadata and raw Markdown cannot inject HTML or unsafe links.
- Internal article links, fragments, code, and tables survive rendering.
- Only intended indexable pages enter sitemap and feed.
- Redirects preserve encoded paths and queries; missing pages return 404.
- Mobile reading and navigation remain useful without JS and under reduced motion.

### Task 1: Content build and publication contract

Files: website/build.mjs; website/lib/content.mjs; website/lib/markdown.mjs;
website/lib/pages.mjs; website/lib/layout.mjs; website/content/**/*.md;
tests/website.test.mjs; package.json; package-lock.json.

Consumes: public docs and the 17 source manuscripts, after editorial review.
Produces: buildSite({ outDir }) and deterministic complete HTML, sitemap, feed,
search index, robots, assets, and 404.

- [ ] Write artifact-level tests for required routes, canonical metadata,
  crawlable links/fragments, structured data, feeds, Markdown safety and collisions.
- [ ] Run the tests and observe failure because the build is absent.
- [ ] Implement validated content loading, safe rendering, shared layout and hubs.
- [ ] Curate the manuscripts and write original research/report methodology pages.
- [ ] Run the focused tests; mutate one canonical, prove failure, restore and pass.
- [ ] Commit the build/content contract after verification.

### Task 2: Visual implementation and working preview

Files: website/public/assets/*.css; website/public/assets/site.js;
website/public/assets/fonts/*; website/lib/home.mjs; website/serve.mjs;
website/worker.mjs; website/PRODUCT.md; website/DESIGN.md.

Consumes: generated page/article structures and content metadata.
Produces: responsive light-only surfaces, navigation, copy interaction, full-text
search, local preview and host-preserving redirect adapter.

- [ ] Add tests for the preview's real routes/404 and the worker redirect contract.
- [ ] Observe failure before implementing those entry points.
- [ ] Build the visual system and authored conversation composition.
- [ ] Self-host fonts, license files, favicon and a generated PNG social image.
- [ ] Implement progressive interactions and the loopback preview server.
- [ ] Inspect real desktop/mobile renders; exercise search, copy, keyboard and
  reduced-motion behavior; fix observed failures.
- [ ] Commit the visual/preview implementation after focused checks.

### Task 3: Verification, presentation and draft PR

Files: .github/workflows/website.yml; website/README.md.

Consumes: static artifact, focused checks and visual evidence.
Produces: reproducible CI build, contributor commands, browser presentation,
full-gate evidence and a draft PR URL.

- [ ] Add a CI build for the static artifact and document authoring/deployment.
- [ ] Run npm run check, npm test, npm pack and verify-package.mjs.
- [ ] Obtain one fresh review of the complete branch, including desktop/mobile
  screenshots. Fix material findings and repeat affected checks.
- [ ] Open the actual local site visibly for the user before creating the PR.
- [ ] Refresh origin/main, check the branch, push with hooks and create a draft PR.
- [ ] Release owned ACC claims and preserve the running preview and useful evidence.
