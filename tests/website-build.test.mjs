import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadContent } from "../website/lib/content.mjs";
import { validateBuiltSite } from "../website/lib/build-contracts.mjs";
import { sections } from "../website/lib/config.mjs";
import { buildSite } from "../website/build.mjs";

const site = path.resolve(import.meta.dirname, "../website");

let ready;
let fixtureRoot;
after(async () => { if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); });
function artifact() {
  return ready ??= (async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "acc-site-contract-"));
    const outDir = path.join(fixtureRoot, "dist");
    await buildSite({ outDir });
    const articles = await loadContent(path.join(site, "content"));
    const expectedRoutes = ["/", ...sections.map(s => "/" + s.id + "/"),
      ...articles.map(a => a.route), "/search/", "/404.html"];
    return { root: fixtureRoot, outDir, articles, expectedRoutes };
  })();
}

test("a broken published link fails the build without replacing its last good output", async t => {
  const { root, outDir } = await artifact();
  const contentDir = path.join(root, "content");
  const before = await readFile(path.join(outDir, "index.html"), "utf8");
  const articleBefore = await readFile(path.join(outDir, "docs/install/index.html"), "utf8");
  await cp(path.join(site, "content"), contentDir, { recursive: true });
  const file = path.join(contentDir, "docs/install.md");
  const source = await readFile(file, "utf8");
  for (const href of ["/missing-page-for-contract/", "./never-existed/", "https://getacc.dev/never-existed/"]) {
    await t.test(href, async () => {
      await writeFile(file, source + "\n\n[Broken reference](" + href + ")\n");
      await assert.rejects(buildSite({ outDir, contentDir }), /unresolved internal link/i);
      assert.equal(await readFile(path.join(outDir, "index.html"), "utf8"), before,
        "a failed candidate must leave the last complete site available");
      assert.equal(await readFile(path.join(outDir, "docs/install/index.html"), "utf8"), articleBefore);
    });
  }
  await writeFile(file, source + "\n\n[Same page](../) "
    + "[Full URL](https://getacc.dev/guides/)\n");
  // Existing relative/absolute references must remain valid.
  await buildSite({ outDir: path.join(root, "valid-links"), contentDir });
});


test("rendered component contracts reject a missing frame or metadata", async t => {
  const fixture = await artifact();
  const file = path.join(fixture.outDir, "index.html");
  const original = await readFile(file, "utf8");
  for (const [name, pattern, expected] of [
    ["header", /<header\b[^>]*>[\s\S]*?<\/header>/, /shared header/],
    ["footer", /<footer\b[^>]*>[\s\S]*?<\/footer>/, /shared footer/],
    ["navigation", /<a href="\/reports\/"[^>]*>[\s\S]*?<\/a>/, /shared navigation/],
    ["home section", /<section\b[^>]*aria-labelledby="local-title"[^>]*>[\s\S]*?<\/section>/, /homepage section/],
    ["H1", /<h1\b[^>]*>[\s\S]*?<\/h1>/, /one H1/],
    ["canonical", /<link rel="canonical"[^>]*>/, /canonical/],
    ["structured data", /<script type="application\/ld\+json">[\s\S]*?<\/script>/, /structured data/],
  ]) {
    await t.test(name, async () => {
      const mutated = original.replace(pattern, "");
      assert.notEqual(mutated, original, "the control must remove the real element");
      try {
        await writeFile(file, mutated);
        await assert.rejects(validateBuiltSite(fixture), expected);
      } finally { await writeFile(file, original); }
    });
  }
});

test("rendered manuscript contracts reject source text loss and duplication", async t => {
  const fixture = await artifact();
  const article = fixture.articles.find(a => a.route === "/guides/connect-ai-coding-sessions/");
  const file = path.join(fixture.outDir, article.route.slice(1), "index.html");
  const original = await readFile(file, "utf8");
  for (const [name, replacement] of [["missing intro", ""], ["duplicate intro", article.introHtml.repeat(2)]]) {
    await t.test(name, async () => {
      const mutated = original.replace(article.introHtml, replacement);
      assert.notEqual(mutated, original, "the control must alter the rendered manuscript");
      try {
        await writeFile(file, mutated);
        await assert.rejects(validateBuiltSite(fixture), /manuscript/);
      } finally { await writeFile(file, original); }
    });
  }
});


test("collection coverage rejects a published client lost from its index", async () => {
  const fixture = await artifact();
  const file = path.join(fixture.outDir, "integrations/index.html");
  const original = await readFile(file, "utf8");
  const entry = [...original.matchAll(/<article class="client-entry">[\s\S]*?<\/article>/g)]
    .map(match => match[0]).find(html => html.includes('href="/integrations/claude-code/"'));
  assert.ok(entry, "the control must target the real published client entry");
  try {
    await writeFile(file, original.replace(entry, ""));
    await assert.rejects(validateBuiltSite(fixture), /collection coverage/);
  } finally { await writeFile(file, original); }
});
