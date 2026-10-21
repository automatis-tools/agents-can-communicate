import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const repo = path.resolve(import.meta.dirname, "..");
const site = path.join(repo, "website");

async function htmlFiles(directory) {
  const found = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) found.push(...await htmlFiles(file));
    else if (item.name.endsWith(".html")) found.push(file);
  }
  return found;
}

test("the built website supplies real, linked, indexable HTML content", async t => {
  const out = await mkdtemp(path.join(tmpdir(), "acc-website-test-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [path.join(site, "build.mjs"), "--out", out],
    { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const files = await htmlFiles(out);
  assert.ok(files.length >= 28, "all collections and substantive manuscripts must be built");
  const titles = new Set();
  const pages = new Map();
  for (const file of files) {
    const relative = path.relative(out, file).split(path.sep).join("/");
    const route = relative === "index.html" ? "/" : relative === "404.html"
      ? "/404.html" : "/" + relative.replace(/index\.html$/, "");
    const html = await readFile(file, "utf8");
    pages.set(route, html);
    assert.equal((html.match(/<h1(?:\s|>)/g) ?? []).length, 1, route + " needs one H1");
    assert.match(html, /<meta name="description" content="[^"]+"/, route);
    assert.match(html, /<meta name="color-scheme" content="light">/, route);
    assert.ok(html.includes('rel="canonical" href="https://getacc.dev' + route + '"'), route);
    const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
    assert.ok(title && !titles.has(title), "unique descriptive title: " + route);
    titles.add(title);
    assert.doesNotMatch(html, /file:\/\/\/|\/Users\/mmykola87|\.analysis\/|research_notes\//);
    const schemas = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    assert.ok(schemas.length, route + " needs structured data");
    for (const schema of schemas) assert.equal(JSON.parse(schema[1])["@context"], "https://schema.org");
  }

  for (const required of ["/", "/docs/", "/guides/", "/integrations/", "/compatibility/",
    "/compare/", "/research/", "/reports/", "/search/", "/404.html"]) {
    assert.ok(pages.has(required), "missing section " + required);
  }
  for (const [route, html] of pages) {
    for (const [, encoded] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const href = encoded.replaceAll("&amp;", "&");
      if (!href.startsWith("/") && !href.startsWith("#")) continue;
      const target = new URL(href, "https://getacc.dev" + route);
      const targetPage = pages.get(target.pathname);
      if (targetPage !== undefined) {
        if (target.hash) assert.ok(targetPage.includes('id="' + decodeURIComponent(target.hash.slice(1)) + '"'),
          route + " has broken fragment " + href);
      } else {
        await assert.doesNotReject(readFile(path.join(out, target.pathname)), route + " links to " + href);
      }
    }
  }
  const sitemap = await readFile(path.join(out, "sitemap.xml"), "utf8");
  const feed = await readFile(path.join(out, "feed.xml"), "utf8");
  for (const route of ["/search/", "/404.html"]) {
    assert.ok(!sitemap.includes("https://getacc.dev" + route));
    assert.match(pages.get(route), /name="robots" content="noindex,follow"/);
  }
  assert.match(sitemap, /https:\/\/getacc\.dev\/guides\/connect-ai-coding-sessions\//);
  assert.match(feed, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
  assert.match(await readFile(path.join(out, "robots.txt"), "utf8"), /Sitemap: https:\/\/getacc.dev\/sitemap.xml/);
});

test("Markdown content cannot introduce scripts or executable link protocols", async () => {
  const { renderMarkdown } = await import("../website/lib/markdown.mjs");
  const rendered = renderMarkdown("# Title\n\n<script>alert(1)</script>\n\n## A heading\n\n[An anchor](#a-heading)");
  assert.ok(rendered.html.includes("&lt;script&gt;"));
  assert.ok(!rendered.html.includes("<script>"));
  assert.ok(rendered.html.includes('id="a-heading"'));
  assert.equal(rendered.headings[0].text, "A heading");
  for (const href of ["javascript:alert%281%29", "data:text/html,test", "file:///etc/passwd", "//example.com"]) {
    assert.throws(() => renderMarkdown("# Title\n\n[unsafe](" + href + ")"), /unsafe link/i);
  }
});

test("article sections respect Markdown block boundaries and shared heading identifiers", async () => {
  const { renderMarkdown } = await import("../website/lib/markdown.mjs");
  const result = renderMarkdown('# Title\n\nAn [intro link][source].\n\n> ## Inside a quote\n> Keep this block intact.\n\n'
    + '## Repeated\n\nFirst body.\n\n### A child\n\n~~~text\n## This is code\n~~~\n\n'
    + '## Repeated\n\nSecond [body link][source].\n\n[source]: https://example.com/reference');
  assert.match(result.introHtml, /<blockquote>[\s\S]*Inside a quote[\s\S]*<\/blockquote>/);
  assert.deepEqual(result.sections.map(section => section.id), ["repeated", "repeated-2"]);
  assert.match(result.sections[0].html, /id="a-child"/);
  assert.match(result.sections[0].html, /<code class="language-text">## This is code/);
  assert.match(result.sections[1].html, /href="https:\/\/example.com\/reference"/);
});

test("every article layout keeps its complete manuscript once in the initial HTML", async () => {
  const { loadContent } = await import("../website/lib/content.mjs");
  const { articlePage } = await import("../website/lib/pages.mjs");
  const { plainText } = await import("../website/lib/config.mjs");
  const articles = await loadContent(path.join(site, "content"));
  assert.equal(new Set(articles.map(article => article.type)).size, 8);
  for (const article of articles) {
    const html = articlePage(article, articles);
    const parts = html.split("<!-- manuscript:start -->");
    assert.equal(parts.length, 2, article.route + " needs one complete manuscript");
    const [body, rest] = parts[1].split("<!-- manuscript:end -->");
    assert.ok(rest, article.route + " needs its manuscript boundary");
    assert.equal(plainText(body), article.text, article.route + " lost, duplicated, or reordered source text");
    for (const heading of article.headings) {
      assert.equal(html.split('id="' + heading.id + '"').length - 1, 1, article.route + " duplicated an anchor");
    }
  }
});

test("content metadata rejects collisions and unsafe publication routes", async t => {
  const { loadContent, parseManuscript } = await import("../website/lib/content.mjs");
  const directory = await mkdtemp(path.join(tmpdir(), "acc-website-content-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manuscript = await readFile(path.join(site, "content/docs/install.md"), "utf8");
  assert.throws(() => parseManuscript(manuscript.replace('"/docs/install/"', '"/../../private/"'), "bad.md"), /invalid route/);
  assert.throws(() => parseManuscript(manuscript.replace('lastVerified: "2026-10-21"', 'lastVerified: "2026-02-31"'), "date.md"), /invalid review date/);
  await writeFile(path.join(directory, "one.md"), manuscript);
  await writeFile(path.join(directory, "two.md"), manuscript);
  await assert.rejects(loadContent(directory), /duplicate content route/);
});

test("article metadata remains text in the rendered review note", async () => {
  const { parseManuscript } = await import("../website/lib/content.mjs");
  const { articlePage } = await import("../website/lib/pages.mjs");
  const source = await readFile(path.join(site, "content/docs/install.md"), "utf8");
  const article = parseManuscript(source.replace('accVersion: "0.11.1"',
    'accVersion: "<img src=x onerror=alert(1)>"'), "metadata.md");
  const html = articlePage(article, [article]);
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
  assert.match(html, /ACC &lt;img src=x onerror=alert\(1\)&gt;\./);
});

test("a query after a failed search index keeps the useful error and article list", async () => {
  const source = await readFile(path.join(site, "public/assets/site.mjs"), "utf8");
  const status = { textContent: "" };
  const field = { value: "", addEventListener() {} };
  const results = [{ hidden: false }];
  let submit;
  const form = { querySelector: () => field, addEventListener: (_, callback) => { submit = callback; } };
  const document = {
    addEventListener() {},
    querySelector: selector => ({ "[data-search-form]": form, "[data-search-status]": status,
      "[data-search-empty]": { hidden: true } })[selector] ?? null,
    querySelectorAll: selector => selector === "[data-search-result]" ? results : [],
  };
  runInNewContext(source, { document, fetch: async () => { throw new Error("offline"); },
    AbortSignal, URLSearchParams, location: { search: "" }, clearTimeout, setTimeout });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(status.textContent, /Search is unavailable/);
  field.value = "handoff";
  submit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(status.textContent, "Search is unavailable. All articles are listed below.");
  assert.equal(results[0].hidden, false);
});

test("a build cannot erase an existing directory it does not own", async t => {
  const { buildSite } = await import("../website/build.mjs");
  const directory = await mkdtemp(path.join(tmpdir(), "acc-website-unowned-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "keep.txt"), "unrelated work");
  await assert.rejects(buildSite({ outDir: directory }), /unowned output/);
  assert.equal(await readFile(path.join(directory, "keep.txt"), "utf8"), "unrelated work");
  await assert.rejects(buildSite({ outDir: site }), /source directory/);
});

test("draft manuscripts never enter the public content collection", async t => {
  const { loadContent } = await import("../website/lib/content.mjs");
  const directory = await mkdtemp(path.join(tmpdir(), "acc-website-drafts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manuscript = await readFile(path.join(site, "content/docs/install.md"), "utf8");
  await writeFile(path.join(directory, "reviewed.md"), manuscript);
  await writeFile(path.join(directory, "draft.md"), manuscript
    .replace('id: "install"', 'id: "unfinished"')
    .replace('"/docs/install/"', '"/docs/unfinished/"')
    .replace('status: "reviewed"', 'status: "draft"'));
  const articles = await loadContent(directory);
  assert.deepEqual(articles.map(article => article.route), ["/docs/install/"]);
});

test("hosting redirects preserve paths and queries and preview HTML is noindex", async () => {
  const { default: worker } = await import("../website/worker.mjs");
  const env = { ASSETS: { fetch: async () => new Response("<h1>Article</h1>",
    { headers: { "content-type": "text/html" } }) } };
  for (const host of ["getacc.app", "www.getacc.app", "www.getacc.dev"]) {
    const response = await worker.fetch(new Request("https://" + host + "/guides/a%2Fb/?q=two%20words"), env);
    assert.equal(response.status, 301);
    assert.equal(response.headers.get("location"), "https://getacc.dev/guides/a%2Fb/?q=two%20words");
  }
  const preview = await worker.fetch(new Request("https://preview.pages.dev/guides/"), env);
  assert.match(preview.headers.get("x-robots-tag"), /noindex/);
  assert.equal(await preview.text(), "<h1>Article</h1>");
  const primary = await worker.fetch(new Request("https://getacc.dev/guides/"), env);
  assert.equal(primary.headers.get("x-robots-tag"), null);
});

test("the local preview serves built routes and real 404s without exposing source", async t => {
  const { buildSite } = await import("../website/build.mjs");
  const { createPreviewServer } = await import("../website/serve.mjs");
  const directory = await mkdtemp(path.join(tmpdir(), "acc-website-http-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await buildSite({ outDir: directory });
  const server = createPreviewServer({ directory });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = "http://127.0.0.1:" + server.address().port;
  const home = await fetch(origin);
  assert.equal(home.status, 200);
  assert.match(home.headers.get("x-robots-tag"), /noindex/);
  assert.match(await home.text(), /Let your agents/);
  const article = await fetch(origin + "/guides/connect-ai-coding-sessions/");
  assert.equal(article.status, 200);
  assert.match(await article.text(), /Choose the sessions you actually use/);
  const withoutSlash = await fetch(origin + "/guides", { redirect: "manual" });
  assert.equal(withoutSlash.status, 301);
  assert.equal(withoutSlash.headers.get("location"), "/guides/");
  for (const route of ["/missing/", "/.acc-website-build", "/%2e%2e%2fpackage.json", "/%00"]) {
    const response = await fetch(origin + route);
    assert.equal(response.status, 404, route);
    assert.match(await response.text(), /The line ends here/);
  }
  const asset = await fetch(origin + "/assets/base.css");
  assert.match(asset.headers.get("content-type"), /text\/css/);
  await asset.text();
  const post = await fetch(origin, { method: "POST" });
  assert.equal(post.status, 405);
  await post.text();
  const auditServer = createPreviewServer({ directory, noindex: false });
  await new Promise(resolve => auditServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { auditServer.closeAllConnections(); auditServer.close(resolve); }));
  const audit = await fetch("http://127.0.0.1:" + auditServer.address().port);
  assert.equal(audit.headers.get("x-robots-tag"), null, "explicit artifact audits can inspect indexable headers");
  await audit.text();
});
