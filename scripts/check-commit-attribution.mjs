#!/usr/bin/env node
// Refuse Claude attribution in commit messages and pull request descriptions:
//   Co-Authored-By: Claude ... / <noreply@anthropic.com>
//   Claude-Session: https://claude.ai/code/session_...
//   Generated with [Claude Code](...)
//
// One check, four callers:
//   .githooks/commit-msg   --message-file <file>
//   .githooks/pre-push     --pre-push <remote>     (whole history of each ref on stdin)
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
const CUT_LINE = "------------------------ >8 ------------------------";
const ZERO = /^0+$/;

const attributionLines = text =>
  text.split(/\r?\n/).filter(line => ATTRIBUTION.some(pattern => pattern.test(line)));

async function git(args) {
  return (await run("git", args, { maxBuffer: 256 * 1024 * 1024 })).stdout;
}

const setting = async key => (await git(["config", "--get", key]).catch(() => "")).trim();

// git hands commit-msg the file before its own cleanup. Only what git's cleanup is
// known to drop is left out, and only in an editor session (without one git sets
// GIT_EDITOR=: and keeps comments and a typed scissors line): everything from the
// scissors line under scissors cleanup, or the `git commit -v` diff below it under
// any cleanup; and comment lines under the default strip cleanup. Both the scissors
// line and a comment start with the configured comment string; with `auto` git
// picks it per message, so nothing is dropped. Everything else is checked as
// written, because git may store it.
//
// An editor session explicitly run with GIT_EDITOR=: reaches the hook exactly like
// a commit with no editor, so it is checked as written too. That can refuse a line
// git would have cleaned away, never accept one git keeps; trusting editor mode
// instead would let every `git commit -F` hide a trailer again.
async function storedMessage(raw) {
  const lines = raw.split(/\r?\n/);
  if (process.env.GIT_EDITOR === ":") return lines.join("\n");
  const comment = (await setting("core.commentString")) || (await setting("core.commentChar")) || "#";
  if (comment === "auto") return lines.join("\n");
  const cleanup = await setting("commit.cleanup");
  const isComment = line => line.startsWith(comment);
  const scissors = lines.indexOf(`${comment} ${CUT_LINE}`);
  const below = scissors === -1 ? undefined : lines.slice(scissors + 1).find(line => !isComment(line));
  const cut = scissors !== -1
    && (cleanup === "scissors" || below === undefined || below.startsWith("diff --git "));
  const kept = cut ? lines.slice(0, scissors) : lines;
  const strips = ["", "default", "strip"].includes(cleanup);
  return (strips ? kept.filter(line => !isComment(line)) : kept).join("\n");
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

// Every pushed ref must carry a clean history, the rule the Lint job applies to
// HEAD: checking only commits new to the remote would let a new branch carry an
// attributed commit that another remote branch already has. Deletions push nothing.
async function pushedTips() {
  const tips = [];
  for (const line of (await readStdin()).split("\n")) {
    const [, localSha] = line.trim().split(/\s+/);
    if (localSha && !ZERO.test(localSha)) tips.push(localSha);
  }
  return tips;
}

function refuse(what, findings) {
  console.error(`${what} refused: Claude attribution is not allowed in this repository.`);
  for (const finding of findings) console.error(finding);
  console.error("Remove the attribution line and try again; never bypass this with --no-verify.");
  process.exit(1);
}

async function commitsGate(what, revisionSets, advice) {
  const found = [];
  // An empty set would make `git log` read HEAD instead of nothing.
  for (const revisions of revisionSets.filter(set => set.length > 0)) {
    found.push(...await offendingCommits(revisions));
  }
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
  await commitsGate("push", [await pushedTips()],
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
