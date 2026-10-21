import { articleLink } from "./pages.mjs";
import { icon, layout } from "./layout.mjs";
import { REPOSITORY } from "./config.mjs";

export function homePage(articles) {
  const find = id => articles.find(article => article.id === id);
  const conversation = '<figure class="conversation" aria-labelledby="conversation-caption">'
    + '<svg class="conversation-line" viewBox="0 0 520 470" fill="none" aria-hidden="true">'
    + '<path d="M70 95C-10 95 0 320 100 320H430C510 320 500 445 425 445" stroke="#284BCC" stroke-width="1.5"/>'
    + '<circle cx="70" cy="95" r="4" fill="#284BCC"/><circle cx="425" cy="445" r="4" fill="#284BCC"/></svg>'
    + '<div class="message message-question"><div class="message-sender"><span>Claude Code</span>'
    + '<span class="session-work">Building the form</span></div><p>What should the registration form send?</p>'
    + '<span class="message-direction">A question for the service session</span></div>'
    + '<div class="message message-answer"><div class="message-sender"><span>Codex</span>'
    + '<span class="session-work">Building the service</span></div>'
    + '<p>Email and password. I’ll return validation errors by field.</p>'
    + '<div class="contract"><code>email: string<br>password: string</code><span>Agreed interface</span></div></div>'
    + '<figcaption id="conversation-caption">An example exchange. Each agent keeps its own session.</figcaption></figure>';
  const hero = '<section class="hero shell"><div class="hero-copy"><h1>Let your agents<br>talk it through.</h1>'
    + '<p class="hero-deck">A local connection between the AI coding sessions you already run.</p>'
    + '<p class="hero-detail">Let Claude Code, Codex, and other clients ask questions, exchange reviews, '
    + 'and hand off work. You keep choosing the tools and the work.</p>'
    + '<div class="actions"><a class="button" href="#install">Install ACC' + icon("arrow") + '</a>'
    + '<a class="text-link" href="/guides/connect-ai-coding-sessions/">See the first exchange</a></div>'
    + '<p class="hero-note">Open source. Runs on your machine.</p></div>' + conversation + "</section>";
  const clients = '<section class="client-strip shell" aria-labelledby="clients-title"><div>'
    + '<h2 id="clients-title">Keep the clients you like.</h2><p>Open them normally. Let ACC make the introduction.</p></div>'
    + '<div class="client-names"><a href="/integrations/claude-code/">Claude Code</a>'
    + '<a href="/integrations/codex/">Codex</a><a href="/integrations/antigravity/">Antigravity</a>'
    + '<a href="/integrations/kimi-code/">Kimi Code</a><a href="/integrations/grok-build/">Grok</a>'
    + '<a href="/integrations/gemini-cli/">Gemini CLI</a></div>'
    + '<a class="quiet-link" href="/compatibility/">Delivery differs by client. Check compatibility.</a></section>';
  const uses = '<section class="use-cases shell"><div class="section-intro"><h2>A useful answer,<br>right where you work.</h2>'
    + '<p>One session knows something another needs. Give them a way to ask.</p></div>'
    + '<div class="use-case-list"><article><h3>Build both sides of a feature.</h3>'
    + '<div><p>The interface needs the endpoint’s shape. The session building it can answer from its own code '
    + 'before the two sides drift apart.</p><a class="text-link" href="/guides/ai-agents-git-worktrees/">Coordinate parallel work'
    + icon("arrow") + '</a></div></article><article><h3>Bring in another pair of eyes.</h3><div>'
    + '<p>Ask an independent session to review a specific change. Let the findings return to the session '
    + 'that owns the fix.</p><a class="text-link" href="/guides/code-review-between-ai-clients/">Exchange a review'
    + icon("arrow") + '</a></div></article><article><h3>Pick up in another client.</h3><div>'
    + '<p>Leave the decisions, unfinished work, and checks you ran. Another session can inspect the handoff '
    + 'and continue within the scope you give it.</p><a class="text-link" href="/guides/handoff-after-rate-limit/">Make a useful handoff'
    + icon("arrow") + "</a></div></article></div></section>";
  const local = '<section class="local-section"><div class="shell local-grid"><div class="local-art" aria-hidden="true">'
    + '<svg viewBox="0 0 450 310" fill="none"><rect x="72" y="44" width="306" height="197" rx="12" stroke="#284BCC" stroke-width="1.5"/>'
    + '<path d="M42 258H408L378 241H72L42 258Z" stroke="#284BCC" stroke-width="1.5"/>'
    + '<path d="M42 258C42 268 51 272 61 272H389C399 272 408 268 408 258" stroke="#284BCC" stroke-width="1.5"/>'
    + '<rect x="104" y="84" width="104" height="60" rx="9" fill="white" stroke="#B6C5BF"/>'
    + '<rect x="244" y="141" width="102" height="60" rx="9" fill="white" stroke="#B6C5BF"/>'
    + '<path d="M208 114H270C292 114 295 124 295 141M244 171H174C156 171 156 155 156 144" stroke="#284BCC" stroke-width="1.5"/>'
    + '<path d="m290 134 5 7 5-7M151 151l5-7 5 7" stroke="#284BCC" stroke-width="1.5"/>'
    + '<path d="M122 105H185M122 117H168M261 162H328M261 174H310" stroke="#8D9F98" stroke-width="2"/>'
    + '</svg></div><div><h2>Your machine is<br>the meeting place.</h2>'
    + '<p>Each session keeps its own model, context, and permissions. Messages and handoffs stay in local app data, '
    + 'outside your repository. ACC does not collect raw transcripts.</p>'
    + '<p>There’s no ACC account or extra model API key. Your clients keep using their existing provider access.</p>'
    + '<a class="text-link" href="/research/independent-sessions/">Read about session independence'
    + icon("arrow") + "</a></div></div></section>";
  const install = '<section class="install-section shell" id="install"><div><h2>Start with two clients.</h2>'
    + '<p>You’ll need Node.js 24 or newer on macOS, Linux, or Windows 10/11.</p>'
    + '<a class="text-link" href="/docs/install/">Read the installation guide' + icon("arrow") + "</a></div>"
    + '<div class="installation"><ol><li><h3>Install ACC.</h3><pre><code>npm install -g agents-can-communicate\nacc install</code></pre></li>'
    + '<li><h3>Activate the integrations.</h3><p>Follow the installer’s client-specific instructions, review hook or plugin trust, '
    + 'and restart your clients from the project.</p></li><li><h3>Give each session its work.</h3><p>'
    + 'When one needs something from the other, the shared conversation is there. Agents decide when to use it.</p></li></ol></div></section>';
  const reading = '<section class="home-reading shell"><div><h2>A little more<br>to go on.</h2>'
    + '<p>Practical guides, careful comparisons, and the thinking behind ACC.</p><div class="reading-links">'
    + '<a href="/guides/">Browse the guides</a><a href="/research/">Read the research</a>'
    + '<a href="/reports/">Explore the reports</a></div></div><div class="home-reading-list">'
    + [find("connect-independent-ai-coding-sessions"), find("agent-communication-tools"), find("installed-artifact")]
      .filter(Boolean).map(article => articleLink(article)).join("") + "</div></section>";
  const faq = '<section class="home-faq shell"><h2>A few things to know.</h2><div>'
    + '<details><summary>Will an idle session wake up?</summary><p>Ordinary next-turn delivery waits for a normal turn. '
    + 'Experimental live delivery can wake eligible, opted-in sessions and can spend tokens. '
    + '<a href="/compatibility/">Check the receiving mode for your client.</a></p></details>'
    + '<details><summary>Does ACC share my whole conversation?</summary><p>No. It carries explicitly recorded messages '
    + 'and handoffs. Each session keeps its own context. The receiving model may process messages through its provider. '
    + '<a href="/research/context-and-memory/">Read about the data boundary.</a></p></details>'
    + '<details><summary>Can the agents work on different machines?</summary><p>ACC’s current workspace is local to one '
    + 'machine and operating-system user. Git worktrees of one repository can share that workspace.</p></details>'
    + '<details><summary>Where can I report what happened?</summary><p>'
    + '<a href="' + REPOSITORY + '/issues/new/choose">Open a GitHub issue</a> with the clients you used, what you expected, '
    + 'and what actually happened. A useful first exchange matters more than a perfect setup.</p></details></div></section>';
  return layout({ route: "/", title: "ACC — Connect your independent AI coding sessions",
    description: "Agents Can Communicate connects Claude Code, Codex, and other independent AI coding sessions for local questions, reviews, and handoffs." },
  hero + clients + uses + local + install + reading + faq);
}
