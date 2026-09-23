#!/usr/bin/env node
// Refuse Claude attribution in commit messages and pull request descriptions:
//   Co-Authored-By: Claude ... / <noreply@anthropic.com>
//   Claude-Session: https://claude.ai/code/session_...
//   Generated with [Claude Code](...)
//
// One check, four callers:
//   .githooks/commit-msg   --message-file <file>
//   .githooks/pre-push     --pre-push <remote>     (git's ref lines on stdin)
//   Lint job               --history <rev>...      and  --text-env PR_BODY
//
// The Lint job runs on the runner's own Node, so this file stays within what
// Node 20 offers: no import.meta.main, no newer built-ins.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const ATTRIBUTION = [
  /^\s*co-authored-by:.*(claude|anthropic)/i,
  /^\s*claude-session:/i,
  /generated with \[?claude code/i,
  /claude\.ai\/code\/session_/i,
];
const SCISSORS = /^# -{24} >8 -{24}$/;
const ZERO = /^0+$/;

const attributionLines = text =>
  text.split(/\r?\n/).filter(line => ATTRIBUTION.some(pattern => pattern.test(line)));

async function git(args) {
  return (await run("git", args, { maxBuffer: 256 * 1024 * 1024 })).stdout;
}

const setting = async key => (await git(["config", "--get", key]).catch(() => "")).trim();

// git hands commit-msg the file before its own cleanup. Only the case git's cleanup
// is known to drop is left out: an editor session (without one git sets
// GIT_EDITOR=:, keeps comments and a typed scissors line) under the default strip
// cleanup with `#` comments loses its comment lines, and `git commit -v` loses the
// diff below its scissors line. Everything else is checked as written, because git
// may store any of it.
async function storedMessage(raw) {
  const lines = raw.split(/\r?\n/);
  if (process.env.GIT_EDITOR === ":") return lines.join("\n");
  const scissors = lines.findIndex(line => SCISSORS.test(line));
  const below = scissors === -1 ? undefined : lines.slice(scissors + 1).find(line => !line.startsWith("#"));
  const verboseDiff = scissors !== -1 && (below === undefined || below.startsWith("diff --git "));
  const kept = verboseDiff ? lines.slice(0, scissors) : lines;
  const cleanup = await setting("commit.cleanup");
  const comment = (await setting("core.commentString")) || (await setting("core.commentChar")) || "#";
  const strips = ["", "default", "strip"].includes(cleanup) && comment === "#";
  return (strips ? kept.filter(line => !line.startsWith("#")) : kept).join("\n");
}

async function offendingCommits(revisions) {
  const log = await git(["log", "--format=%h%x00%s%x00%B%x01", ...revisions]);
  return log.split("\x01").map(record => record.replace(/^\n/, "")).filter(Boolean)
    .map(record => {
      const [sha, subject, body] = record.split("\x00");
      return { sha, subject, lines: attributionLines(body) };
    })
    .filter(commit => commit.lines.length > 0);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// One rev-list argument set per pushed ref. A new ref, or a remote tip this clone
// has never seen, is checked against everything the remote already has.
async function pushedRevisions(remote) {
  const sets = [];
  for (const line of (await readStdin()).split("\n")) {
    const [, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue;
    const known = remoteSha && !ZERO.test(remoteSha)
      && await git(["cat-file", "-e", `${remoteSha}^{commit}`]).then(() => true, () => false);
    sets.push(known ? [`${remoteSha}..${localSha}`] : [localSha, "--not", `--remotes=${remote}`]);
  }
  return sets;
}

function refuse(what, findings) {
  console.error(`${what} refused: Claude attribution is not allowed in this repository.`);
  for (const finding of findings) console.error(finding);
  console.error("Remove the attribution line and try again; never bypass this with --no-verify.");
  process.exit(1);
}

async function commitsGate(what, revisionSets, advice) {
  const found = [];
  for (const revisions of revisionSets) found.push(...await offendingCommits(revisions));
  const unique = [...new Map(found.map(commit => [commit.sha, commit])).values()];
  if (unique.length === 0) return;
  refuse(what, [...unique.map(commit => `  ${commit.sha} ${commit.subject}\n    ${commit.lines.join("\n    ")}`),
    advice]);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "--message-file" && rest.length === 1) {
  const lines = attributionLines(await storedMessage(await readFile(rest[0], "utf8")));
  if (lines.length > 0) refuse("commit", lines.map(line => `  ${line}`));
} else if (mode === "--pre-push" && rest.length >= 1) {
  await commitsGate("push", await pushedRevisions(rest[0]),
    "Reword those commits first (git rebase -i <base>, mark each as reword).");
} else if (mode === "--history" && rest.length >= 1) {
  await commitsGate("history", [rest],
    "Rewrite those messages; published history needs a coordinated force push.");
} else if (mode === "--text-env" && rest.length === 1) {
  const lines = attributionLines(process.env[rest[0]] ?? "");
  if (lines.length > 0) refuse(`${rest[0]}`, lines.map(line => `  ${line}`));
} else {
  console.error("usage: check-commit-attribution.mjs --message-file <file> | --pre-push <remote> [url]"
    + " | --history <rev>... | --text-env <NAME>");
  process.exit(2);
}
