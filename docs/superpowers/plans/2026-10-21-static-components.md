# ACC Static Components Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The user delegated execution and decisions; no plan review or intermediate approval is required.

**Goal:** Compile the ACC website from reusable typed components into complete, validated static HTML with small progressive enhancements and verified search/AI discovery.

**Architecture:** Astro 7.4.2 renders native server components at build time. Preserve the safe curated-content parser, all31 public routes,22 manuscripts, the approved hero and current brand/layout families. Build into an owned staging directory, validate rendered contracts, then promote complete output.

**Tech Stack:** Node24+, Astro7.4.2, @astrojs/check0.9.12, compatible TypeScript6.0.3, marked18.1.1; an isolated private website package. No React, SPA router or server adapter.

**Spec:** website/PRODUCT.md plus website/ARCHITECTURE.md; the user's static-component and SEO/AI research request is the scope authority.

## Global Constraints

- Primarygetacc.dev; getacc.app/www301 aliases; preserve every route and anchor.
- Light only; semantic palette and contrast in website/BRAND.md; preserve the accepted hero.
- Retain6index structures and6reading families for8article metadata types.
- Only reviewed website/content enters HTML, search, feeds or Markdown mirrors.
- No fabricated evidence, authorship, dates, rating or client capability.
- Keep production modules and components below300lines when practical.
- Keep website dependencies outside ACC's runtime package and preserve packed provenance.
- Never merge, mark ready, deploy or modify DNS. Update existing draftPR317 after local showing and gates.

## Review Focus

- A missing shared frame or manuscript must fail before replacing the last good output.
- Unsafe metadata/Markdown and unpublished drafts must remain non-executable and unpublished.
- Parallel/default/custom-output builds must not corrupt each other's caches or source paths.
- Shared components must preserve each page family's reading layout, keyboard behavior and mobile bounds.
- Crawler controls, structured data and machine-readable variants must describe actual public content without ranking promises.

---

### Task 1: Rendered contracts and safe output

**Files:** website/lib/build-contracts.mjs, website/lib/build-output.mjs, website/build.mjs; tests/website-build.test.mjs.

**Interfaces:** preserve buildSite({outDir?,contentDir?})->Promise<{outDir,pages,articles}>; introduce validateBuiltSite({outDir,articles,expectedRoutes})->Promise<report> and owned-stage/promotion helpers consumed by Task2.

- [ ] Write an integration test requiring broken published internal links to reject the build and preserve a sentinel in the last good owned output.
- [ ] Run it against the old builder. Expected: FAIL because the build incorrectly succeeds.
- [ ] Add staging, complete-route/frame/H1/manuscript/anchor/asset checks, and promotion after validation.
- [ ] Add controlled missing-frame/manuscript mutations. Expected: named contract rejection; restored output passes.
- [ ] Run Node24 focused website/build tests. Expected: all pass; commit the independently useful guard.

### Task 2: Native Astro components

**Files:** website/package.json, website/package-lock.json, astro.config.mjs, tsconfig.json; website/src/{components,layouts,pages,data,lib,styles,scripts}; build wrapper; tests/website.test.mjs and website-helpers.mjs; CIwebsite.yml/ci.yml; AGENTS.md.

**Interfaces:** typed Article, ArticleSection, SitePage, SiteSection and breadcrumb data; shared SiteLayout, SeoHead, Header, Footer, Icon, InstallCommand, Illustration, ArticleMeta, Contents and Manuscript components. Home sections,6indexes and6article-family components compose these. Reuse Task1 validation/promotion.

- [ ] Keep the captured31-page baseline and derive tests from curated source and actual built output, not legacy renderer functions.
- [ ] Add exact private website dependencies and CI/bootstrap setup. Root package/lock remain unchanged.
- [ ] Replace HTML-string page renderers with native.astro composition. Only sanitized Markdown fragments and safely serialized JSON-LD use set:html.
- [ ] Build from an isolated source/data/cache snapshot so parallel tests do not share mutable Astro caches.
- [ ] Run component typecheck and actual static build. Expected:31HTML pages,22 complete manuscripts, no client islands/router and no local-path leakage.
- [ ] Compare semantic baseline and accepted hero; exercise missing shared component/body controls. Expected: faulty artifact rejected before promotion; restored output and tests pass.
- [ ] Commit component migration.

### Task 3: Verified SEO and agent discovery

**Files:** shared SeoHead/data helpers, static discovery writer, worker.mjs, serve.mjs, website/SEO.md; website tests.

**Interfaces:** static search-index, sitemap and Atom from the same reviewed data; article index.md mirrors with canonicalHTML Link/noindex headers; llms.txt as optional navigation, not a ranking signal.

- [ ] Write tests for reviewed-only canonical discovery/Markdown outputs and headers. Expected: FAIL for absent artifacts/headers.
- [ ] Implement initialHTMLmetadata/JSON-LD, canonical hierarchy, internal linking and static discovery outputs. Separate real review dates from invented publication/modification dates.
- [ ] Preserve crawling access and distinguish search bots from training crawlers. No bot-specific alternate content or external submissions.
- [ ] Record primary-source research in SEO.md with dated sources and limits. Expected: claims match Google/Bing/OpenAI documentation; no specialAI-schema promise.
- [ ] Run focused tests and commit.

### Task 4: Integration and handoff

**Files:** README/architecture/brand references, final rendered evidence and draftPR317.

**Interfaces:** standard npmci+website npmci setup, rootcheck/test/pack gates, static preview4179.

- [ ] Check all31 routes at desktop/mobile/middle widths and the full homepage flow; verify copy/search/contents/menu/table behavior.
- [ ] Check static asset/JS budgets and actual browser resource loading. Do not label local observations fieldCWV or indexing acceptance.
- [ ] Run fresh whole-branch source/visual review with the review focus and ledger rulings; fix material findings with regressions.
- [ ] Run exact installed-package verification and the complete unbypassed pre-push gates after final commits.
- [ ] Show local output, update draftPR, release owned claims and archive necessary evidence; leave the current preview, never merge or deploy.
