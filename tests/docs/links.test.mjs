import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repo = path.resolve(import.meta.dirname, "..", "..");

function outsideFences(markdown) {
  const kept = [];
  let fence = null;
  for (const line of markdown.split("\n")) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/u)?.[1] ?? null;
    if (fence === null && marker !== null) {
      fence = marker[0];
      kept.push("");
    } else if (fence !== null && marker?.[0] === fence) {
      fence = null;
      kept.push("");
    } else {
      kept.push(fence === null ? line : "");
    }
  }
  return kept.join("\n");
}

function headingSlug(heading) {
  return heading
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/<[^>]*>/gu, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_ -]/gu, "")
    .replace(/\s+/gu, "-");
}

export function headingAnchors(markdown) {
  const anchors = new Set();
  const occurrences = new Map();
  for (const line of outsideFences(markdown).split("\n")) {
    const heading = line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/u)?.[1];
    if (heading === undefined) continue;
    const base = headingSlug(heading);
    const seen = occurrences.get(base) ?? 0;
    anchors.add(seen === 0 ? base : `${base}-${seen}`);
    occurrences.set(base, seen + 1);
  }
  return anchors;
}

export function localFragmentLinks(markdown) {
  const links = [];
  for (const match of outsideFences(markdown)
    .matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)) {
    const raw = match[1].replace(/^<|>$/gu, "");
    if (/^[a-z][a-z\d+.-]*:/iu.test(raw)) continue;
    const hash = raw.indexOf("#");
    if (hash === -1 || hash === raw.length - 1) continue;
    links.push({ target: decodeURIComponent(raw.slice(0, hash).split("?", 1)[0]),
      fragment: decodeURIComponent(raw.slice(hash + 1)) });
  }
  return links;
}

async function publicMarkdown() {
  const files = ["README.md", "SECURITY.md", "AGENTS.md"];
  for (const directory of ["docs", "examples"]) {
    for (const entry of await readdir(path.join(repo, directory), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(path.posix.join(directory, entry.name));
      }
    }
  }
  return files.sort();
}

test("local fragment links name headings that exist", async () => {
  const missing = [];
  for (const file of await publicMarkdown()) {
    const source = await readFile(path.join(repo, file), "utf8");
    for (const link of localFragmentLinks(source)) {
      const target = link.target === "" ? file
        : path.posix.normalize(path.posix.join(path.posix.dirname(file), link.target));
      const targetSource = await readFile(path.join(repo, target), "utf8").catch(() => null);
      if (targetSource === null || !headingAnchors(targetSource).has(link.fragment)) {
        missing.push(`${file} -> ${target}#${link.fragment}`);
      }
    }
  }
  assert.deepEqual(missing, [], `documentation has missing fragments:\n${missing.join("\n")}`);
});

test("heading anchors ignore fences and normalize inline code and duplicates", () => {
  const anchors = headingAnchors([
    "# `First` heading!",
    "```md",
    "# Not a heading",
    "```",
    "## Same",
    "## Same",
  ].join("\n"));

  assert.deepEqual([...anchors], ["first-heading", "same", "same-1"]);
});

test("fragment links ignore fences and decode encoded paths and fragments", () => {
  const links = localFragmentLinks([
    "[same page](#first%2Dheading)",
    "[other](OTHER%20PAGE.md#response-contracts)",
    "```md",
    "[sample](MISSING.md#not-real)",
    "```",
  ].join("\n"));

  assert.deepEqual(links, [
    { target: "", fragment: "first-heading" },
    { target: "OTHER PAGE.md", fragment: "response-contracts" },
  ]);
});
