import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createClaudeCodeAdapter } from "@agents-can-communicate/adapter-claude-code";
import { createCodexAdapter } from "@agents-can-communicate/adapter-codex";
import { createGeminiCliAdapter } from "@agents-can-communicate/adapter-gemini-cli";
import { createGrokAdapter } from "@agents-can-communicate/adapter-grok";
import { createKimiAdapter } from "@agents-can-communicate/adapter-kimi";

/**
 * Every address a reader is shown has to be one the product accepts.
 *
 * `--to models` shipped in the README, the getting-started guide, the CLI
 * reference and all five skills, and it resolved nowhere: recipients were exact
 * participant ids, so `models` was a placeholder nobody had marked as one. An
 * agent following its own skill met `no participant here is called models` on
 * its first attempt to reach a peer, and the same skill tells it to report a
 * failed command briefly and carry on - so coordination stopped there, quietly.
 *
 * The executable-doc test runs the blocks marked `<!-- test:command -->`, but
 * neither the README block nor any skill carries that marker, which is why
 * eighteen wrong examples survived. This checks the addresses themselves.
 */
const repo = fileURLToPath(new URL("../..", import.meta.url));

const ADAPTER_IDS = new Set([createClaudeCodeAdapter(), createCodexAdapter(),
  createGeminiCliAdapter(), createGrokAdapter(), createKimiAdapter()].map(a => a.id));

// A participant id as an adapter writes one: `<adapter>-<suffix>`. Documentation
// may also show an angle-bracket placeholder, which no reader mistakes for a name.
const isPlaceholder = value => value.startsWith("<") && value.endsWith(">");
const isParticipantId = value => [...ADAPTER_IDS].some(id => value.startsWith(`${id}-`));

async function documents() {
  const files = ["README.md"];
  for (const entry of await readdir(path.join(repo, "docs"))) {
    if (entry.endsWith(".md")) files.push(path.join("docs", entry));
  }
  for (const pkg of await readdir(path.join(repo, "packages"))) {
    for (const shape of ["plugin/skills/acc/SKILL.md", "extension/skills/acc/SKILL.md"]) {
      const file = path.join("packages", pkg, shape);
      const source = await readFile(path.join(repo, file), "utf8").catch(() => null);
      if (source !== null) files.push(file);
    }
  }
  return Promise.all(files.map(async file => ({ file,
    source: await readFile(path.join(repo, file), "utf8") })));
}

test("every documented --to names something the product would accept", async () => {
  const wrong = [];
  for (const { file, source } of await documents()) {
    for (const match of source.matchAll(/--to\s+(\S+)/g)) {
      const value = match[1].replace(/[`'"\\]/g, "");
      if (ADAPTER_IDS.has(value) || isParticipantId(value) || isPlaceholder(value)) continue;
      wrong.push(`${file}: --to ${value}`);
    }
  }

  assert.deepEqual(wrong, [],
    "these addresses resolve to nobody; a reader copying them gets exit 4");
});

// Found by running the shipped examples against an installed build rather than
// by reading them: a client name never resolves to the sender's own client, so
// `request --to claude_code` in Claude's own skill is refused for the one agent
// most likely to run it. Every skill has to name a peer.
test("no skill tells an agent to address its own client", async () => {
  const wrong = [];
  for (const { file, source } of await documents()) {
    if (!file.endsWith("SKILL.md")) continue;
    const own = [...ADAPTER_IDS].find(id =>
      file.includes(`adapter-${id.replaceAll("_", "-")}/`) || file.includes(`adapter-${id}/`));
    assert.ok(own, `cannot tell which adapter ships ${file}`);
    for (const match of source.matchAll(/--to\s+(\S+)/g)) {
      if (match[1] === own) wrong.push(`${file}: --to ${own}`);
    }
  }

  assert.deepEqual(wrong, [],
    "the sender's own client is excluded from resolution, so this example is refused");
});

test("at least one skill teaches addressing by client, since that is what an agent knows",
  async () => {
    const skills = (await documents()).filter(entry => entry.file.endsWith("SKILL.md"));
    assert.equal(skills.length, 5);
    for (const { file, source } of skills) {
      // The roster an agent is handed names clients. Telling it only about exact
      // participant ids sends it to `status` first, which is the lookup it skips.
      assert.match(source, /Address a peer by its client/,
        `${file} does not say a client name is an address`);
      assert.match(source, /two sessions of one client have to be\s+named exactly/,
        `${file} does not say what happens when the client name is ambiguous`);
    }
  });
