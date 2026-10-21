import { icon, layout } from "./layout.mjs";
import { REPOSITORY } from "./config.mjs";
import { sectionIllustration } from "./illustrations.mjs";

export function homePage() {
  const introduction = '<section class="tool-intro"><div class="helper-copy"><h1>The missing link<br>between your coding agents.</h1>'
    + '<p class="tool-description">Stop carrying messages between tabs. ACC connects your coding sessions so they can ask questions, review changes, and pass work on.</p>'
    + '<div class="tool-install" id="install"><pre><code>npm install -g agents-can-communicate\nacc install</code></pre>'
    + '<div class="install-links"><a class="button" href="/docs/install/">Connect your agents</a><a href="'
    + REPOSITORY + '">GitHub</a></div><p>Open source · Node.js 24+ · No ACC account</p></div></div>'
    + '<div class="helper-object" aria-hidden="true"><img src="/assets/acc-helper-v1.webp" width="900" height="600" alt="" fetchpriority="high" decoding="async"></div></section>';
  const conversation = `<section class="home-story home-conversation" aria-labelledby="conversation-title">
    <div class="conversation-lead"><h2 id="conversation-title">Let the session with the context answer.</h2>
      <p>Your frontend session needs an API detail. The session building the backend already knows it. Give them a way to ask each other.</p>
      <a class="text-link" href="/guides/connect-ai-coding-sessions/">Make your first connection ${icon("arrow")}</a>
      </div>
    <figure class="conversation-example"><dl>
      <div class="example-turn"><dt>Claude Code <span>Building the form</span></dt>
        <dd>What should the registration form send to the API?</dd></div>
      <div class="example-turn example-reply"><dt>Codex <span>Building the API</span></dt>
        <dd>Email and password. I’ll return validation errors by field.</dd></div>
    </dl><figcaption>Illustrative exchange. Each session keeps its own context and permissions.
      <a href="/guides/message-delivery/">How delivery works</a>.</figcaption></figure>
  </section>`;
  const review = `<section class="home-story home-review" aria-labelledby="review-title">
    ${sectionIllustration("research", "home-review-art")}
    <div><h2 id="review-title">Bring another model into the review.</h2>
      <p>Keep the session that knows the code. Ask a second one for a focused review, then bring the findings back.</p>
      <p class="review-detail">A specific change, a fresh perspective, and a clear path back to the session making the fix.</p>
      <a class="text-link" href="/guides/code-review-between-ai-clients/">Try a cross-client review ${icon("arrow")}</a></div>
  </section>`;
  const handoff = `<section class="home-story home-handoff" aria-labelledby="handoff-title">
    ${sectionIllustration("reports", "home-handoff-art")}
    <div><h2 id="handoff-title">Carry the work into your next session.</h2>
      <p>A rate limit or a new client shouldn’t mean reconstructing the work. Leave a handoff with the decisions, unfinished changes, and checks.</p>
      <a class="text-link" href="/guides/handoff-after-rate-limit/">Continue in another client ${icon("arrow")}</a></div>
  </section>`;
  const clientLinks = [
    ["Claude Code", "claude-code", "Terminal and local Code sessions"],
    ["Codex", "codex", "CLI and app delivery notes"],
    ["Antigravity", "antigravity", "CLI and desktop setup"],
    ["Gemini CLI", "gemini-cli", "Next-turn delivery and inbox"],
    ["Kimi Code", "kimi-code", "Terminal session setup"],
    ["Grok Build", "grok-build", "Explicit inbox workflow"],
  ].map(([name, route, note]) => `<li><a href="/integrations/${route}/"><strong>${name}</strong>
    <span>${note}</span>${icon("arrow")}</a></li>`).join("");
  const clients = `<section class="home-story home-clients" aria-labelledby="clients-title">
    <div class="home-section-heading"><h2 id="clients-title">Start with the clients you already use.</h2>
      <p>Choose a client for setup and receiving behavior. <a href="/compatibility/">Compare delivery support</a>.</p></div>
    <ul class="home-client-list">${clientLinks}</ul>
  </section>`;
  const local = `<section class="home-story home-local" aria-labelledby="local-title">
    <div><h2 id="local-title">Keep control of the setup.</h2><a class="text-link" href="/research/independent-sessions/">Why sessions stay independent ${icon("arrow")}</a></div>
    <div><p>Your coding clients keep their own models, context, and permissions. ACC stores messages and handoffs on your machine, outside the repository.</p>
      <p>No ACC account or extra model API key. Your clients keep using their existing providers; ACC does not collect raw transcripts.</p></div>
  </section>`;
  const reading = `<section class="home-story home-reading" aria-labelledby="reading-title">
    <div class="home-section-heading"><h2 id="reading-title">Read the thinking behind ACC.</h2><a href="/research/">All research ${icon("arrow")}</a></div>
    <div class="home-reading-pair"><article><h3><a href="/research/independent-sessions/">Independent sessions, shared conversation</a></h3>
      <p>Why a useful connection should preserve what makes each session different.</p><a class="reading-category" href="/research/">Research</a></article>
    <article><h3><a href="/reports/installed-artifact/">Test the package people actually install</a></h3>
      <p>How ACC checks the artifact that reaches your machine, with evidence you can inspect.</p><a class="reading-category" href="/reports/">Engineering reports</a></article></div>
    <a class="text-link reading-more" href="/compare/agent-communication-tools/">Compare agent communication approaches ${icon("arrow")}</a>
  </section>`;
  const closing = `<section class="home-story home-closing" aria-labelledby="closing-title">
    <div class="home-questions"><h2>Before you connect</h2>
      <details><summary>Will an idle session wake up?</summary><p>Ordinary next-turn delivery waits for a normal turn.
        Experimental live delivery is a separate opt-in, depends on the client, and can spend model tokens.
        <a href="/guides/message-delivery/">Read about delivery</a>.</p></details>
      <details><summary>Can sessions run on different machines?</summary><p>ACC’s current workspace is local to one machine
        and operating-system user. Git worktrees of one repository can share that workspace.</p></details></div>
    <div class="home-final-action"><h2 id="closing-title">Let your next two sessions talk.</h2>
      <a class="button" href="/docs/install/">Connect your agents</a>
      <a class="text-link" href="/guides/connect-ai-coding-sessions/">Read the first-connection guide ${icon("arrow")}</a>
      <p>Something unexpected? <a href="${REPOSITORY}/issues/new/choose">Open an issue</a>.</p></div>
  </section>`;
  return layout({ route: "/", title: "ACC — Connect your AI coding agents",
    description: "Connect Claude Code, Codex, and other AI coding sessions with ACC. Exchange questions, reviews, and handoffs locally, without relaying every message yourself." },
    '<div class="tool-page">' + introduction + conversation + review + handoff + clients + local + reading + closing + '</div>');
}
