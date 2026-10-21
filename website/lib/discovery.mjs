import { writeFile } from "node:fs/promises";
import path from "node:path";
import { ORIGIN, sections } from "./config.mjs";

// Convenience for direct readers/agents; HTML remains the canonical search target.
export async function writeAgentDiscovery(directory, articles) {
  const index = ["# Agents Can Communicate (ACC)", "",
    "> Local-first communication between independent AI coding sessions.", "",
    "HTML pages are canonical. These Markdown copies contain the same reviewed manuscripts.",
    "This index is a reading convenience, not a search-ranking requirement.", ""];
  for (const section of sections) {
    index.push("## " + section.label, "");
    for (const article of articles.filter(item => item.section === section.id)) {
      await writeFile(path.join(directory, article.route, "index.md"),
        "Canonical: " + ORIGIN + article.route + "\n"
        + "Reviewed: " + article.lastVerified + " · ACC " + article.accVersion + "\n\n"
        + article.markdown + "\n");
      index.push("- [" + article.title.replaceAll("[", "\\[").replaceAll("]", "\\]") + "](" + ORIGIN
        + article.route + "index.md): " + article.description);
    }
    index.push("");
  }
  await writeFile(path.join(directory, "llms.txt"), index.join("\n"));
}
