import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadContent } from "./lib/content.mjs";
import { withOutputStage } from "./lib/build-output.mjs";
import { validateBuiltSite } from "./lib/build-contracts.mjs";
import { writeAgentDiscovery } from "./lib/discovery.mjs";
import { compileAstro } from "./lib/astro-build.mjs";
import { ORIGIN, REVIEW_DATE, escapeHtml as xml, sections } from "./lib/config.mjs";

const siteRoot = import.meta.dirname;

function sitemap(pages) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + [...pages.keys()].filter(route => !["/404.html", "/search/"].includes(route))
      .map(route => "<url><loc>" + ORIGIN + route + "</loc></url>").join("\n")
    + "\n</urlset>\n";
}

function feed(articles) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n'
    + '<title>Agents Can Communicate</title><id>' + ORIGIN + '/</id><link href="' + ORIGIN + '/"/>'
    + '<link href="' + ORIGIN + '/feed.xml" rel="self"/><updated>' + REVIEW_DATE + "T00:00:00Z</updated>"
    + "<author><name>ACC project</name></author>"
    + [...articles].sort((a, b) => b.lastVerified.localeCompare(a.lastVerified) || a.title.localeCompare(b.title))
      .map(article => "<entry><title>" + xml(article.title) + "</title><id>" + ORIGIN + article.route
        + '</id><link href="' + ORIGIN + article.route + '"/><updated>' + article.lastVerified
        + "T00:00:00Z</updated><summary>" + xml(article.description) + "</summary></entry>").join("\n")
    + "\n</feed>\n";
}

export async function buildSite({ outDir = path.join(siteRoot, "dist"),
  contentDir = path.join(siteRoot, "content") } = {}) {
  outDir = path.resolve(outDir);
  contentDir = path.resolve(contentDir);
  const articles = await loadContent(contentDir);
  if (!articles.length) throw new Error("refusing to build an empty content library");
  const pages = new Map(["/", ...sections.map(section => "/" + section.id + "/"),
    ...articles.map(article => article.route), "/search/", "/404.html"].map(route => [route, null]));
  await withOutputStage({ outDir, siteRoot, contentDir }, async stage => {
    await compileAstro(stage, articles);
    await writeAgentDiscovery(stage, articles);
    await writeFile(path.join(stage, "sitemap.xml"), sitemap(pages));
    await writeFile(path.join(stage, "feed.xml"), feed(articles));
    await writeFile(path.join(stage, "robots.txt"), "User-agent: *\nAllow: /\n\nSitemap: " + ORIGIN + "/sitemap.xml\n");
    await writeFile(path.join(stage, "search-index.json"), JSON.stringify(articles.map(article => ({
      route: article.route, title: article.title, description: article.description, section: article.section, text: article.text,
    }))));
    const worker = path.join(siteRoot, "worker.mjs");
    const workerSource = await readFile(worker, "utf8").catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (workerSource) await writeFile(path.join(stage, "_worker.js"), workerSource);
    await validateBuiltSite({ outDir: stage, articles, expectedRoutes: [...pages.keys()] });
  });
  return { outDir, pages: pages.size, articles: articles.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== "--out")) throw new Error("usage: node website/build.mjs [--out directory]");
    const result = await buildSite(args.length ? { outDir: args[1] } : {});
    console.log("ACC website built: " + result.pages + " pages, " + result.articles + " articles → " + result.outDir);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
