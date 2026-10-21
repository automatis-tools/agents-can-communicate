import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { siteArtifact } from "./website-helpers.mjs";

// Runs the shipped script with its actual built index. The small DOM double
// records visible results and real UI reordering, not implementation scores.
async function searchUI() {
  const out = await siteArtifact();
  const data = JSON.parse(await readFile(path.join(out, "search-index.json"), "utf8"));
  const source = await readFile(path.join(out, "assets/site.mjs"), "utf8");
  const rows = data.map(article => ({ dataset: { searchResult: article.route }, hidden: false }));
  const container = { children: [...rows], append(row) {
    this.children = this.children.filter(child => child !== row); this.children.push(row);
  } };
  for (const row of rows) row.parentElement = container;
  const status = { textContent: "" }, empty = { hidden: true };
  const field = { value: "", addEventListener() {} };
  let submit;
  const form = { querySelector: () => field, addEventListener: (_, listener) => { submit = listener; } };
  const document = { addEventListener() {}, querySelector: selector => ({
    "[data-search-form]": form, "[data-search-status]": status, "[data-search-empty]": empty,
    ".search-results": container,
  })[selector] ?? null, querySelectorAll: selector => selector === "[data-search-result]" ? rows : [] };
  runInNewContext(source, { document, fetch: async () => ({ ok: true, json: async () => data }),
    history: { replaceState() {} }, location: { search: "" }, AbortSignal, URLSearchParams, clearTimeout, setTimeout });
  return async query => {
    field.value = query;
    await submit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    return { routes: container.children.filter(row => !row.hidden).map(row => row.dataset.searchResult),
      status: status.textContent, empty: empty.hidden };
  };
}

test("hyphens and punctuation find the same real articles as word separators", async () => {
  const search = await searchUI();
  const expected = await search("rate limit");
  assert.ok(expected.routes.includes("/guides/handoff-after-rate-limit/"));
  for (const query of ["rate-limit", "rate–limit", "RATE_limit", "rate.limit", " rate / limit "]) {
    assert.deepEqual((await search(query)).routes, expected.routes, query);
  }
});

test("client-name searches put the integration ahead of comparisons and body mentions", async () => {
  const search = await searchUI();
  assert.equal((await search("Codex")).routes[0], "/integrations/codex/");
  assert.equal((await search("Claude Code")).routes[0], "/integrations/claude-code/");
  assert.equal((await search("codex plugin")).routes[0], "/compare/acc-vs-codex-plugin/");
});

test("clearing a ranked query restores the complete original library", async () => {
  const search = await searchUI();
  const initial = await search("");
  await search("Codex");
  assert.deepEqual((await search("")).routes, initial.routes);
  const missing = await search("no-such-article-zyxwvu");
  assert.equal(missing.routes.length, 0);
  assert.equal(missing.empty, false);
});
