import { layout } from "./layout.mjs";
import { REPOSITORY } from "./config.mjs";

export function homePage() {
  const introduction = '<section class="tool-intro"><div class="helper-copy"><h1>The missing link<br>between your coding agents.</h1>'
    + '<p class="tool-description">Stop carrying messages between tabs. ACC connects your coding sessions so they can ask questions, review changes, and pass work on.</p>'
    + '<div class="tool-install" id="install"><pre><code>npm install -g agents-can-communicate\nacc install</code></pre>'
    + '<div class="install-links"><a class="button" href="/docs/install/">Connect your agents</a><a href="'
    + REPOSITORY + '">GitHub</a></div><p>Open source · Node.js 24+ · No ACC account</p></div></div>'
    + '<div class="helper-object" aria-hidden="true"><img src="/assets/acc-helper-v1.webp" width="900" height="600" alt="" fetchpriority="high" decoding="async"></div></section>';
  const example = '<section class="tool-example"><h2>Let them ask each other</h2><p>Your frontend session needs the API contract. Give it a way to ask.</p>'
    + '<dl class="exchange"><div><dt>Claude Code <span>working on the form</span></dt>'
    + '<dd>What should the registration form send to the API?</dd></div><div><dt>Codex <span>working on the API</span></dt>'
    + '<dd>Email and password. I’ll return validation errors by field.</dd></div></dl>'
    + '<p class="example-caption">Illustrative exchange. Each session keeps its own context and permissions. '
    + '<a href="/guides/connect-ai-coding-sessions/">Make your first connection</a>.</p></section>';
  const uses = '<section class="tool-uses"><h2>Put your agents in touch</h2><ul>'
    + '<li><a href="/guides/ai-agents-git-worktrees/">Keep both sides in sync</a>Let the session building your UI ask the one shaping your API before their assumptions drift apart.</li>'
    + '<li><a href="/guides/code-review-between-ai-clients/">Get another model’s review</a>Send a change to another coding session and bring its findings back to the one doing the work.</li>'
    + '<li><a href="/guides/handoff-after-rate-limit/">Pick up where you left off</a>Carry decisions, unfinished work, and checks into your next coding session.</li></ul></section>';
  const clients = '<section class="tool-clients"><h2>The coding clients you already use</h2><div>'
    + '<a href="/integrations/claude-code/">Claude Code</a><a href="/integrations/codex/">Codex</a>'
    + '<a href="/integrations/antigravity/">Antigravity</a><a href="/integrations/gemini-cli/">Gemini CLI</a>'
    + '<a href="/integrations/kimi-code/">Kimi Code</a><a href="/integrations/grok-build/">Grok Build</a></div>'
    + '<p>Setup and message delivery depend on the client. <a href="/compatibility/">Compare delivery support</a>.</p></section>';
  const local = '<section class="tool-local"><h2>Keep your workflow yours</h2><p>Keep the clients and models you already chose. '
    + 'ACC adds a local way for their sessions to communicate, with messages and handoffs stored outside your repository.</p>'
    + '<p>No ACC account or extra model API key. Your coding clients keep using their existing providers; ACC does not collect raw transcripts. '
    + '<a href="/research/independent-sessions/">How local communication works</a>.</p></section>';
  const reading = '<section class="tool-reading"><h2>Find your next step</h2><dl>'
    + '<div><dt><a href="/docs/">Docs</a></dt><dd>Installation, commands, configuration, and compatibility.</dd></div>'
    + '<div><dt><a href="/guides/">Guides</a></dt><dd>Connect sessions, get a second review, or hand work over.</dd></div>'
    + '<div><dt><a href="/integrations/">Integrations</a></dt><dd>Setup and receiving behavior for each client.</dd></div>'
    + '<div><dt><a href="/compare/">Comparisons</a></dt><dd>Choose the connection that fits how you work.</dd></div>'
    + '<div><dt><a href="/research/">Research</a></dt><dd>Notes on session independence, context, and messages.</dd></div>'
    + '<div><dt><a href="/reports/">Reports</a></dt><dd>Engineering methods and the evidence behind them.</dd></div></dl></section>';
  const details = '<section class="tool-details"><h2>Before you connect</h2>'
    + '<details><summary>Will an idle session wake up?</summary><p>Ordinary next-turn delivery waits for a normal turn. '
    + 'Experimental live delivery is a separate opt-in, depends on the client, and can spend model tokens. '
    + '<a href="/guides/message-delivery/">Read about delivery</a>.</p></details>'
    + '<details><summary>Can sessions run on different machines?</summary><p>ACC’s current workspace is local to one machine '
    + 'and operating-system user. Git worktrees of one repository can share that workspace.</p></details>'
    + '<p class="closing-action"><a class="button" href="/docs/install/">Connect your agents</a></p>'
    + '<p class="issue-link">Something unexpected? <a href="' + REPOSITORY + '/issues/new/choose">Open an issue</a> '
    + 'with your clients, expected behavior, and what happened.</p></section>';
  return layout({ route: "/", title: "ACC — Connect your AI coding agents",
    description: "Connect Claude Code, Codex, and other AI coding sessions with ACC. Exchange questions, reviews, and handoffs locally, without relaying every message yourself." },
    '<div class="tool-page">' + introduction + uses + example + clients + local + reading + details + '</div>');
}
