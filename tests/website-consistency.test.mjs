import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { siteArtifact } from "./website-helpers.mjs";
import { loadContent } from "../website/lib/content.mjs";

const site = path.resolve(import.meta.dirname, "../website");

// Catches a reading family whose contents exist only after the manuscript
// (Reports previously hid that single copy on mobile).
test("every article family provides complete contents before its manuscript", async () => {
  const articles = await loadContent(path.join(site, "content"));
  const outDir = await siteArtifact();
  for (const article of articles) {
    const html = await readFile(path.join(outDir, article.route, "index.html"), "utf8");
    const before = html.split("<!-- manuscript:start -->")[0];
    const menus = [...before.matchAll(/<nav\b[^>]*class="reading-outline"[^>]*>([\s\S]*?)<\/nav>/g)];
    assert.ok(menus.length, article.route + " needs contents before the manuscript");
    for (const [, menu] of menus) {
      for (const section of article.sections) assert.ok(menu.includes('href="#' + section.id + '"'),
        article.route + " lost contents entry " + section.id);
    }
  }
});

// Catches reusing a search-result H2 inside a related-reading H2 section.
test("related articles use subordinate headings while search results keep H2 headings", async () => {
  const outDir = await siteArtifact();
  const articles = await loadContent(path.join(site, "content"));
  for (const article of articles) {
    const html = await readFile(path.join(outDir, article.route, "index.html"), "utf8");
    const related = html.match(/<section class="related-reading">([\s\S]*?)<\/section>/)?.[1];
    if (!related) continue;
    const cards = [...related.matchAll(/<article class="article-link">([\s\S]*?)<\/article>/g)];
    assert.ok(cards.length);
    assert.equal((related.match(/<h2\b/g) ?? []).length, 1, article.route + " needs one related-reading section heading");
    for (const [, card] of cards) assert.match(card, /<h3\b[^>]*><a href="/, article.route + " needs subordinate card headings");
  }
  const search = await readFile(path.join(outDir, "search/index.html"), "utf8");
  for (const [, card] of search.matchAll(/<article class="article-link">([\s\S]*?)<\/article>/g)) {
    assert.match(card, /<h2\b[^>]*><a href="/);
  }
});
