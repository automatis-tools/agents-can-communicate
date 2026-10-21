import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { renderMarkdown } from "./markdown.mjs";
import { plainText, sectionForType } from "./config.mjs";

const required = ["id", "title", "description", "route", "type", "language",
  "author", "lastVerified", "accVersion", "evidenceLevel", "status"];

export function parseManuscript(source, filename) {
  const match = source.replaceAll("\r\n", "\n").match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(filename + ": missing JSON-value frontmatter");
  const metadata = {};
  for (const line of match[1].split("\n")) {
    const field = line.match(/^([a-zA-Z][a-zA-Z0-9]*):\s*(.+)$/);
    if (!field || Object.hasOwn(metadata, field[1])) throw new Error(filename + ": invalid metadata line");
    try { metadata[field[1]] = JSON.parse(field[2]); }
    catch { throw new Error(filename + ": metadata values must be valid JSON: " + field[1]); }
  }
  for (const key of required) {
    if (typeof metadata[key] !== "string" || !metadata[key].trim()) {
      throw new Error(filename + ": missing " + key);
    }
  }
  if (!["reviewed", "draft"].includes(metadata.status)) throw new Error(filename + ": invalid editorial status");
  if (!/^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)+$/.test(metadata.route)
    || !sectionForType(metadata.type)) throw new Error(filename + ": invalid route or content type");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(metadata.lastVerified)
    || Number.isNaN(Date.parse(metadata.lastVerified))
    || new Date(metadata.lastVerified).toISOString().slice(0, 10) !== metadata.lastVerified) {
    throw new Error(filename + ": invalid review date");
  }
  const body = match[2].trim();
  if ((body.match(/^# /gm) ?? []).length !== 1) throw new Error(filename + ": expected one source H1");
  if (metadata.title !== body.match(/^# (.+)$/m)[1]) throw new Error(filename + ": title and source H1 differ");
  const rendered = renderMarkdown(body);
  return { ...metadata, ...rendered, section: sectionForType(metadata.type), filename,
    text: plainText(rendered.html), minutes: Math.max(1, Math.ceil(plainText(rendered.html).split(" ").length / 220)) };
}

export async function loadContent(directory) {
  const articles = [];
  async function visit(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error("content symlinks are not permitted: " + entry.name);
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.name.endsWith(".md")) {
        const article = parseManuscript(await readFile(file, "utf8"), file);
        if (article.status === "reviewed") articles.push(article);
      }
    }
  }
  await visit(directory);
  const routes = new Set();
  for (const article of articles) {
    if (routes.has(article.route)) throw new Error("duplicate content route: " + article.route);
    routes.add(article.route);
  }
  return articles;
}
