import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadContent } from "../../lib/content.mjs";
import type { Article } from "./types";

let cached: Promise<Article[]> | undefined;
export function getArticles(): Promise<Article[]> {
  return cached ??= (async () => {
    if (process.env.ACC_WEBSITE_DATA) {
      return JSON.parse(await readFile(process.env.ACC_WEBSITE_DATA, "utf8")) as Article[];
    }
    return await loadContent(fileURLToPath(new URL("../../content/", import.meta.url))) as unknown as Article[];
  })();
}
