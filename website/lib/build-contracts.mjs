import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { ORIGIN, plainText, sections } from "./config.mjs";

const attribute = (tag, name) => tag.match(new RegExp('(?:^|\\s)' + name + '="([^"]*)"'))?.[1];

function requireFrame(route, html) {
  const header = html.match(/<header\b[^>]*class="[^"]*\bsite-header\b[^"]*"[^>]*>[\s\S]*?<\/header>/g) ?? [];
  const footer = html.match(/<footer\b[^>]*class="[^"]*\bsite-footer\b[^"]*"[^>]*>[\s\S]*?<\/footer>/g) ?? [];
  if (header.length !== 1) throw new Error("shared header contract failed: " + route);
  if (footer.length !== 1) throw new Error("shared footer contract failed: " + route);
  for (const label of ["Main", "Mobile"]) {
    const navigation = header[0].match(new RegExp('<nav\\b[^>]*aria-label="' + label + '"[^>]*>([\\s\\S]*?)<\\/nav>'))?.[1];
    for (const section of sections) {
      if (!navigation?.includes('href="/' + section.id + '/"')) {
        throw new Error("shared navigation contract failed: " + route + " (" + label + ") → " + section.id);
      }
    }
  }
  if ((html.match(/<main(?:\s|>)/g) ?? []).length !== 1) throw new Error("one main landmark required: " + route);
  if ((html.match(/<h1(?:\s|>)/g) ?? []).length !== 1) throw new Error("one H1 required: " + route);
  const links = [...html.matchAll(/<link\b[^>]*>/g)].map(match => match[0]);
  const canonical = links.filter(tag => attribute(tag, "rel") === "canonical");
  if (canonical.length !== 1 || attribute(canonical[0], "href") !== ORIGIN + route) {
    throw new Error("canonical contract failed: " + route);
  }
  const description = [...html.matchAll(/<meta\b[^>]*>/g)]
    .find(([tag]) => attribute(tag, "name") === "description")?.[0];
  if (!description || !attribute(description, "content")?.trim()) throw new Error("description required: " + route);
  const schemas = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(([, attributes]) => attribute(attributes, "type") === "application/ld+json");
  try {
    if (!schemas.length || schemas.some(([, , json]) => JSON.parse(json)["@context"] !== "https://schema.org")) {
      throw new Error("missing schema");
    }
  } catch { throw new Error("structured data contract failed: " + route); }
}

function requireManuscript(article, html) {
  const parts = html.split("<!-- manuscript:start -->");
  const end = parts[1]?.split("<!-- manuscript:end -->");
  if (parts.length !== 2 || end?.length !== 2 || plainText(end[0]) !== article.text) {
    throw new Error("manuscript contract failed: " + article.route);
  }
  for (const heading of article.headings) {
    const escaped = heading.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = html.match(new RegExp('(?:^|\\s)id="' + escaped + '"', "g")) ?? [];
    if (matches.length !== 1) throw new Error("manuscript anchor contract failed: " + article.route + "#" + heading.id);
  }
}

export async function renderedPages(directory) {
  const pages = new Map();
  async function visit(current) {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, item.name);
      if (item.isDirectory()) await visit(file);
      else if (item.name.endsWith(".html")) {
        const relative = path.relative(directory, file).split(path.sep).join("/");
        const route = relative === "index.html" ? "/" : relative === "404.html"
          ? "/404.html" : "/" + relative.replace(/index\.html$/, "");
        pages.set(route, await readFile(file, "utf8"));
      }
    }
  }
  await visit(directory);
  return pages;
}

export async function validateBuiltSite({ outDir, expectedRoutes, articles = [] }) {
  const pages = await renderedPages(outDir);
  for (const route of expectedRoutes) if (!pages.has(route)) throw new Error("missing built page: " + route);
  for (const route of pages.keys()) if (!expectedRoutes.includes(route)) throw new Error("unexpected built page: " + route);
  for (const [route, html] of pages) {
    requireFrame(route, html);
    for (const [, encoded] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const href = encoded.replaceAll("&amp;", "&");
      if (!href.startsWith("/") && !href.startsWith("#")) continue;
      const target = new URL(href, ORIGIN + route);
      if (target.origin !== ORIGIN) throw new Error("unsafe internal reference: " + href);
      const page = pages.get(target.pathname);
      if (page !== undefined) {
        if (target.hash && !page.includes('id="' + decodeURIComponent(target.hash.slice(1)) + '"')) {
          throw new Error("unresolved internal link: " + route + " → " + href);
        }
      } else {
        const relative = decodeURIComponent(target.pathname);
        const file = path.resolve(outDir, "." + relative);
        if (!file.startsWith(outDir + path.sep) || !(await stat(file).catch(() => null))?.isFile()) {
          throw new Error("unresolved internal link: " + route + " → " + href);
        }
      }
    }
  }
  for (const article of articles) requireManuscript(article, pages.get(article.route));
  return { pages: pages.size };
}
