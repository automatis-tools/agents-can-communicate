import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { siteArtifact } from "./website-helpers.mjs";
import { loadContent } from "../website/lib/content.mjs";
import { renderedPages, validateBuiltSite } from "../website/lib/build-contracts.mjs";

const site = path.resolve(import.meta.dirname, "../website");
const navigation = html => [...html.matchAll(/<nav\b[^>]*aria-label="Documentation"[^>]*>([\s\S]*?)<\/nav>/g)]
  .map(([, body]) => [...body.matchAll(/<a\b([^>]*?)href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/g)]
    .map(([, before, href, after, label]) => ({ href, label: label.replace(/<[^>]*>/g, "").trim(),
      current: (before + after).includes('aria-current="page"') })));

// Catches replacing either page's shared sidebar with a partial/custom menu.
test("Docs overview and every documentation article expose the same complete menu", async () => {
  const outDir = await siteArtifact();
  const articles = (await loadContent(path.join(site, "content"))).filter(a => a.section === "docs");
  const routes = ["/docs/", ...articles.map(a => a.route)];
  let overview;
  for (const route of routes) {
    const html = await readFile(path.join(outDir, route, "index.html"), "utf8");
    const menus = navigation(html);
    assert.equal(menus.length, 2, route + " needs complete desktop and mobile menus");
    for (const menu of menus) {
      for (const [href, label] of [["/docs/", "Overview"], ["/docs/#quickstart", "Quick start"],
        ["/docs/install/", "Install ACC"], ["/compatibility/", "Client compatibility"]]) {
        assert.ok(menu.some(link => link.href === href && link.label === label), route + " lost " + label);
      }
      for (const file of ["CLI.md", "CONFIGURATION.md", "PROTOCOL.md", "ARCHITECTURE.md", "TROUBLESHOOTING.md", "SECURITY_MODEL.md"]) {
        assert.ok(menu.some(link => link.href.endsWith("/docs/" + file)), route + " lost reference " + file);
      }
      for (const article of articles) assert.ok(menu.some(link => link.href === article.route));
      assert.deepEqual(menu.filter(link => link.current).map(link => link.href), [route], "active page: " + route);
      const destinations = menu.map(({ href, label }) => ({ href, label }));
      overview ??= destinations;
      assert.deepEqual(destinations, overview, route + " must preserve menu order, labels and destinations");
    }
  }
});

// Catches a divergent rendered menu before that candidate replaces good output.
test("the build contract rejects a documentation page that loses a shared menu link", async () => {
  const outDir = await siteArtifact();
  const file = path.join(outDir, "docs/install/index.html");
  const original = await readFile(file, "utf8");
  const menus = navigation(original);
  assert.ok(menus.length > 0, "mutate the real shared menu");
  const mutated = original.replace(/<a\b[^>]*href="\/docs\/#quickstart"[^>]*>[\s\S]*?<\/a>/, "");
  assert.notEqual(mutated, original);
  try {
    await writeFile(file, mutated);
    const articles = await loadContent(path.join(site, "content"));
    await assert.rejects(validateBuiltSite({ outDir, articles, expectedRoutes: [...(await renderedPages(outDir)).keys()] }),
      /documentation navigation/);
  } finally { await writeFile(file, original); }
});


// Equality alone must not allow every page to lose the same responsive menu
// or the same reference destination.
test("the build rejects a shared omission across all documentation pages", async t => {
  const outDir = await siteArtifact();
  const articles = await loadContent(path.join(site, "content"));
  const originals = await Promise.all(["/docs/", ...articles.filter(a => a.section === "docs").map(a => a.route)]
    .map(async route => { const file = path.join(outDir, route, "index.html"); return { file, html: await readFile(file, "utf8") }; }));
  const expectedRoutes = [...(await renderedPages(outDir)).keys()];
  for (const [name, mutate] of [
    ["mobile menu", html => html.replace(/<details class="documentation-mobile">[\s\S]*?<\/details>/, "")],
    ["reference destination", html => html.replace(/<nav\b[^>]*aria-label="Documentation"[^>]*>[\s\S]*?<\/nav>/g,
      menu => menu.replace(/<a\b[^>]*href="[^"]*\/docs\/SECURITY_MODEL\.md"[^>]*>[\s\S]*?<\/a>/, ""))],
  ]) {
    await t.test(name, async () => {
      try {
        for (const { file, html } of originals) {
          const mutated = mutate(html);
          assert.notEqual(mutated, html, "the control must remove the real " + name);
          await writeFile(file, mutated);
        }
        await assert.rejects(validateBuiltSite({ outDir, articles, expectedRoutes }), /documentation navigation/);
      } finally { for (const { file, html } of originals) await writeFile(file, html); }
    });
  }
});
