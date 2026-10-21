import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadContent } from "./lib/content.mjs";
import { homePage } from "./lib/home.mjs";
import { articlePage, collectionPage, notFoundPage, searchPage } from "./lib/pages.mjs";
import { ORIGIN, REVIEW_DATE, escapeHtml as xml, sections } from "./lib/config.mjs";

const siteRoot = import.meta.dirname;
const marker = ".acc-website-build";

async function prepareOutput(outDir, contentDir) {
  for (const source of [siteRoot, contentDir]) {
    if (source === outDir || source.startsWith(outDir + path.sep) || outDir === path.parse(outDir).root) {
      throw new Error("output must not replace a source directory");
    }
  }
  const existing = await readdir(outDir).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (existing.length) {
    const owned = await readFile(path.join(outDir, marker), "utf8").catch(() => "");
    if (owned !== "ACC website output\n") throw new Error("refusing to replace an unowned output directory");
    await rm(outDir, { recursive: true });
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, marker), "ACC website output\n");
}

function sitemap(pages) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + [...pages.keys()].filter(route => !["/404.html", "/search/"].includes(route))
      .map(route => "<url><loc>" + ORIGIN + route + "</loc><lastmod>" + REVIEW_DATE + "</lastmod></url>").join("\n")
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
  const pages = new Map();
  function add(route, html) {
    if (pages.has(route)) throw new Error("duplicate page route: " + route);
    pages.set(route, html);
  }
  add("/", homePage(articles));
  for (const section of sections) add("/" + section.id + "/", collectionPage(section, articles));
  for (const article of articles) add(article.route, articlePage(article, articles));
  add("/search/", searchPage(articles));
  add("/404.html", notFoundPage());
  await prepareOutput(outDir, contentDir);
  await cp(path.join(siteRoot, "public"), outDir, { recursive: true });
  for (const [route, html] of pages) {
    const file = path.join(outDir, route === "/404.html" ? "404.html" : route.slice(1), route.endsWith("/") ? "index.html" : "");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, html);
  }
  await writeFile(path.join(outDir, "sitemap.xml"), sitemap(pages));
  await writeFile(path.join(outDir, "feed.xml"), feed(articles));
  await writeFile(path.join(outDir, "robots.txt"), "User-agent: *\nAllow: /\n\nSitemap: " + ORIGIN + "/sitemap.xml\n");
  await writeFile(path.join(outDir, "search-index.json"), JSON.stringify(articles.map(article => ({
    route: article.route, title: article.title, description: article.description, section: article.section, text: article.text,
  }))));
  const worker = path.join(siteRoot, "worker.mjs");
  const workerSource = await readFile(worker, "utf8").catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (workerSource) await writeFile(path.join(outDir, "_worker.js"), workerSource);
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
