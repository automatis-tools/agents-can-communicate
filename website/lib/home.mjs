import { layout } from "./layout.mjs";
import { REPOSITORY } from "./config.mjs";

export function homePage() {
  const introduction = '<section class="tool-intro"><h1>ACC <span>Agents Can Communicate</span></h1>'
    + '<p class="tool-description">A small, local helper that lets your coding agents talk to each other.</p>'
    + '<p>Keep using Claude Code, Codex, Antigravity, or another supported client. ACC lets independent sessions '
    + 'ask questions, exchange reviews, and leave handoffs.</p>'
    + '<div class="tool-install" id="install"><pre><code>npm install -g agents-can-communicate\nacc install</code></pre>'
    + '<div class="install-links"><a class="button" href="/docs/install/">Setup instructions</a><a href="'
    + REPOSITORY + '">Source on GitHub</a></div><p>Node.js 24+. macOS, Linux, Windows 10/11.</p></div></section>';
  const example = '<section class="tool-example"><h2>A small example</h2><p>Two sessions are building the same feature.</p>'
    + '<dl class="exchange"><div><dt>Claude Code <span>working on the form</span></dt>'
    + '<dd>What should the registration form send to the API?</dd></div><div><dt>Codex <span>working on the API</span></dt>'
    + '<dd>Email and password. I’ll return validation errors by field.</dd></div></dl>'
    + '<p class="example-caption">Illustrative exchange. Each session keeps its own context and permissions. '
    + '<a href="/guides/connect-ai-coding-sessions/">Try a first exchange</a>.</p></section>';
  const uses = '<section class="tool-uses"><h2>Useful for</h2><ul>'
    + '<li><a href="/guides/ai-agents-git-worktrees/">Working on both sides of a feature</a> — agree on the interface before the code drifts apart.</li>'
    + '<li><a href="/guides/code-review-between-ai-clients/">Getting another model’s review</a> — send a specific change and bring the findings back.</li>'
    + '<li><a href="/guides/handoff-after-rate-limit/">Continuing in another client</a> — leave the decisions, unfinished work, and checks.</li></ul></section>';
  const clients = '<section class="tool-clients"><h2>Client integrations</h2><div>'
    + '<a href="/integrations/claude-code/">Claude Code</a><a href="/integrations/codex/">Codex</a>'
    + '<a href="/integrations/antigravity/">Antigravity</a><a href="/integrations/gemini-cli/">Gemini CLI</a>'
    + '<a href="/integrations/kimi-code/">Kimi Code</a><a href="/integrations/grok-build/">Grok Build</a></div>'
    + '<p>Delivery differs by client. <a href="/compatibility/">Check compatibility</a> before expecting an idle session to wake.</p></section>';
  const local = '<section class="tool-local"><h2>What stays local</h2><p>ACC stores messages and handoffs in local app data, '
    + 'outside your repository. It does not collect raw transcripts. Each session keeps its own model, context, and permissions.</p>'
    + '<p>No ACC account or extra model API key is needed. Your coding clients still use their existing providers. '
    + '<a href="/research/independent-sessions/">More about the boundaries</a>.</p></section>';
  const reading = '<section class="tool-reading"><h2>Documentation and reading</h2><dl>'
    + '<div><dt><a href="/docs/">Docs</a></dt><dd>Installation, commands, configuration, and compatibility.</dd></div>'
    + '<div><dt><a href="/guides/">Guides</a></dt><dd>Practical workflows across coding clients.</dd></div>'
    + '<div><dt><a href="/integrations/">Integrations</a></dt><dd>Setup and receiving behavior for each client.</dd></div>'
    + '<div><dt><a href="/compare/">Comparisons</a></dt><dd>Where ACC fits alongside other approaches.</dd></div>'
    + '<div><dt><a href="/research/">Research</a></dt><dd>Notes on session independence, context, and messages.</dd></div>'
    + '<div><dt><a href="/reports/">Reports</a></dt><dd>Engineering methods and the evidence behind them.</dd></div></dl></section>';
  const details = '<section class="tool-details"><h2>Delivery details</h2>'
    + '<details><summary>Will an idle session wake up?</summary><p>Ordinary next-turn delivery waits for a normal turn. '
    + 'Experimental live delivery is a separate opt-in, depends on the client, and can spend model tokens. '
    + '<a href="/guides/message-delivery/">Read about delivery</a>.</p></details>'
    + '<details><summary>Can sessions run on different machines?</summary><p>ACC’s current workspace is local to one machine '
    + 'and operating-system user. Git worktrees of one repository can share that workspace.</p></details>'
    + '<p class="issue-link">Something unexpected? <a href="' + REPOSITORY + '/issues/new/choose">Open an issue</a> '
    + 'with your clients, expected behavior, and what happened.</p></section>';
  return layout({ route: "/", title: "ACC — Connect your independent AI coding sessions",
    description: "Agents Can Communicate is a small local helper for questions, reviews, and handoffs between independent AI coding sessions." },
    '<div class="tool-page">' + introduction + example + uses + clients + local + reading + details + '</div>');
}
