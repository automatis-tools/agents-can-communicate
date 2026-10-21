import { breadcrumbs, icon, layout } from "./layout.mjs";
import { escapeHtml as e, readableDate, REPOSITORY } from "./config.mjs";
import { clientDetails, comparisonDetails, guideDetails, referenceLinks, reportDetails } from "./collection-details.mjs";

const link = (article, text = article.title, className = "") => '<a class="' + className
  + '" href="' + e(article.route) + '">' + e(text) + "</a>";
const minutes = article => '<span class="read-time">' + article.minutes + " min read</span>";
const reviewed = article => '<time datetime="' + article.lastVerified + '">'
  + readableDate(article.lastVerified) + "</time>";
const intro = section => '<p class="section-intro">' + e(section.intro) + "</p>";

function guides(section, articles) {
  const first = articles.find(article => article.id === "connect-independent-ai-coding-sessions") ?? articles[0];
  return '<header class="guides-heading"><h1>Guides</h1><p>One useful exchange.<br>Then the next.</p></header>'
    + '<div class="guide-workbench"><section class="guide-start"><span class="section-caption">Start here</span>'
    + '<h2>' + link(first, "Connect your first two sessions") + '</h2><p>Go from two open clients to a question and a useful answer.</p>'
    + '<ol class="guide-steps"><li>Open two clients on related work.</li><li>Ask the session with the missing context.</li>'
    + '<li>Bring its answer back into your work.</li></ol><div class="guide-start-bottom">'
    + link(first, "Follow the connection guide", "text-link") + minutes(first) + '</div></section>'
    + '<section class="guide-tasks" aria-labelledby="guide-tasks-title"><h2 id="guide-tasks-title">What are you working on?</h2>'
    + articles.filter(article => article !== first).map(article => {
      const [task, description] = guideDetails[article.id] ?? [article.title, article.description];
      return '<article class="guide-task"><div><h3>' + link(article, task) + '</h3><p>' + e(description)
        + '</p></div><div class="guide-task-tail">' + minutes(article) + icon("arrow") + "</div></article>";
    }).join("") + '</section></div><aside class="guide-footnote"><p>Looking for a particular client?</p>'
    + '<a href="/integrations/">Go to the integration catalogue' + icon("arrow") + "</a></aside>";
}

function integrations(section, articles) {
  return '<header class="integrations-heading"><div><h1>Integrations</h1><p class="section-deck">Keep the clients you like.</p>'
    + intro(section) + '</div><div class="connection-key" aria-label="ACC connects your client to another independent session">'
    + '<span>Your client</span><span class="connection-line"></span><strong>ACC</strong>'
    + '<span class="connection-line"></span><span>Another session</span></div></header>'
    + '<div class="integration-directory"><section class="client-catalogue" aria-label="Coding clients">'
    + articles.map(article => {
      const client = clientDetails[article.id] ?? { name: article.title, surface: "Coding client", note: article.description };
      return '<article class="client-entry"><p class="client-surface">' + e(client.surface) + '</p><h2>'
        + link(article, client.name) + '</h2><p>' + e(client.note) + '</p><a class="client-setup" href="'
        + e(article.route) + '">Set up ' + e(client.name) + icon("arrow") + "</a></article>";
    }).join("") + '</section><aside class="integration-notes"><h2>Same conversation.<br>Different delivery.</h2>'
    + '<p>A client’s hooks, permissions, and current state determine when a message arrives.</p>'
    + '<dl><dt>Next turn</dt><dd>Messages join a normal client turn.</dd><dt>Inbox</dt>'
    + '<dd>The session explicitly checks for messages.</dd><dt>Experimental live delivery</dt>'
    + '<dd>A separate opt-in, with client-specific limits.</dd></dl><a href="/compatibility/">Read the compatibility reference</a>'
    + '</aside></div><p class="catalogue-footer">Install ACC once. Activate each integration according to its own instructions. '
    + '<a href="/docs/install/">Installation guide</a></p>';
}

function comparisons(section, articles) {
  const overview = articles.find(article => article.type === "comparison-hub") ?? articles[0];
  return '<header class="compare-heading"><h1>Comparisons</h1><p>Choose the workflow<br>before the tool.</p></header>'
    + '<section class="compare-overview"><div><h2>' + link(overview, "What kind of connection do you need?")
    + '</h2><p>Peer conversation, delegation, a mailbox, and terminal automation solve different problems. '
    + 'Start with the work you want to keep.</p></div><a class="button" href="' + e(overview.route)
    + '">Read the workflow overview' + icon("arrow") + '</a></section>'
    + '<section class="comparison-index" aria-labelledby="comparison-index-title"><div class="comparison-index-heading">'
    + '<h2 id="comparison-index-title">Take a closer look.</h2><p>Primary documentation. Explicit trade-offs. No scorecards.</p></div>'
    + '<div class="comparison-columns" aria-hidden="true"><span>ACC compared with</span><span>The question to settle</span><span>Focus</span></div>'
    + articles.filter(article => article !== overview).map(article => {
      const [name, question, focus] = comparisonDetails[article.id] ?? [article.title, article.description, "Workflow"];
      return '<article class="comparison-row"><h3>' + link(article, name) + '</h3><p>' + e(question)
        + '</p><span class="comparison-focus">' + e(focus) + '</span></article>';
    }).join("") + '</section><aside class="comparison-method"><span>How to read these</span><p>These are documentation-based comparisons, '
    + 'not head-to-head client benchmarks. Each article names its sources and the limits of the comparison.</p></aside>';
}

function research(section, articles) {
  const [lead, ...remaining] = articles;
  return '<header class="research-heading"><h1>Research</h1><p>Notes on how independent<br>sessions work together.</p>'
    + '<a href="/feed.xml">Follow the reading feed</a></header><section class="research-lead" aria-label="Featured research">'
    + '<div class="research-lead-copy"><p class="research-subject">Session independence</p><h2>' + link(lead)
    + '</h2><p class="research-abstract">' + e(lead.description) + '</p><div class="research-byline">'
    + '<span>ACC project</span>' + minutes(lead) + '</div></div><figure class="research-figure">'
    + '<div class="context-model"><div><span>Session A</span><strong>Its own context</strong></div>'
    + '<p>A question<br><span>↓</span><br>An answer</p><div><span>Session B</span><strong>Its own context</strong></div></div>'
    + '<figcaption>Messages cross the boundary.<br>Each session keeps its own context.</figcaption></figure></section>'
    + '<div class="research-notes">' + remaining.map(article => '<article class="research-note"><div><span class="section-caption">A closer look</span>'
      + minutes(article) + '</div><h2>' + link(article) + '</h2><p>' + e(article.description) + '</p></article>').join("")
    + '</div><aside class="research-colophon"><h2>Questions before conclusions.</h2><p>These notes describe the model behind ACC. '
    + 'Sources, assumptions, and the boundary of each claim stay with the text.</p></aside>';
}

function reports(section, articles) {
  return '<header class="reports-heading"><div><h1>Reports</h1><p>Show the working.</p></div>'
    + '<p class="reports-intro">Engineering methods you can inspect.<br>The question, the procedure, and what it can establish.</p></header>'
    + '<div class="report-register-heading"><h2>Engineering register</h2><span>Methods and verification</span></div>'
    + '<div class="report-register">' + articles.map(article => {
      const report = reportDetails[article.id] ?? { topic: "Engineering", question: article.description,
        method: "See the procedure and sources in the report.", boundary: "Read the report’s scope before applying its conclusions." };
      return '<article class="report-dossier"><header><span class="report-tab">' + e(report.topic) + '</span>'
        + '<span class="report-kind">Method report</span></header><div class="report-dossier-body"><div class="report-title">'
        + '<h2>' + link(article) + '</h2><p>' + e(report.question) + '</p></div><dl><dt>Procedure</dt><dd>' + e(report.method)
        + '</dd><dt>What this does not establish</dt><dd>' + e(report.boundary) + '</dd></dl></div><footer><span>Sources reviewed '
        + reviewed(article) + '</span>' + minutes(article) + link(article, "Open the report") + '</footer></article>';
    }).join("") + '</div><aside class="reports-note"><h2>Evidence travels with the claim.</h2><p>A method is not a new benchmark result. '
    + 'Recorded measurements and client captures keep their original version, environment, and provenance.</p></aside>';
}

function docs(section, articles) {
  const install = articles.find(article => article.id === "install") ?? articles[0];
  const compatibility = articles.find(article => article.route === "/compatibility/");
  return '<div class="docs-workspace"><aside class="docs-sidebar"><nav aria-label="Documentation"><p>Getting started</p>'
    + '<a href="#quickstart">Quick start</a>' + link(install) + '<a href="#client-compatibility">Client compatibility</a>'
    + '<p>Reference</p>' + referenceLinks.map(([title, file]) => '<a href="' + REPOSITORY + '/blob/main/docs/' + file + '">'
      + e(title) + '</a>').join("") + '</nav><a class="docs-search" href="/search/">' + icon("search") + 'Search the library</a></aside>'
    + '<div class="docs-content"><header class="docs-heading"><h1>Docs</h1><p>Get connected.<br>Keep the reference close.</p></header>'
    + '<section class="docs-quickstart" id="quickstart"><div><h2>A first connection</h2><p>Node.js 24 or newer. '
    + 'macOS, Linux, or Windows 10/11.</p></div><pre><code class="language-bash">npm install -g agents-can-communicate\nacc install\n</code></pre>'
    + '<p>Follow the installer’s client-specific activation steps, then open two sessions on related work.</p>'
    + link(install, "Read the full installation guide", "text-link") + '</section>'
    + '<section class="docs-client-reference" id="client-compatibility"><div><h2>Which client are you using?</h2>'
    + '<p>Receiving a message, waking a session, and explicit inbox access are different capabilities.</p></div>'
    + (compatibility ? link(compatibility, "Client compatibility", "text-link") : '<a href="/integrations/">Integration guides</a>') + '</section>'
    + '<section class="docs-reference" id="reference"><h2>Technical reference</h2><p class="docs-reference-intro">'
    + 'The complete reference lives with the source. These links open the repository documentation.</p><div class="docs-reference-grid">'
    + referenceLinks.map(([title, file, description]) => '<article><h3><a href="' + REPOSITORY + '/blob/main/docs/' + file + '">'
      + e(title) + '</a></h3><p>' + e(description) + '</p></article>').join("") + '</div></section>'
    + articles.filter(article => article !== install && article !== compatibility).map(article => '<article class="docs-extra"><h2>'
      + link(article) + '</h2><p>' + e(article.description) + '</p></article>').join("") + '</div></div>';
}

const renderers = { guides, integrations, compare: comparisons, research, reports, docs };

export function collectionPage(section, articles) {
  const sorted = articles.filter(article => article.section === section.id)
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.title.localeCompare(b.title));
  if (!sorted.length) throw new Error("collection needs reviewed content: " + section.id);
  return layout({ route: "/" + section.id + "/", section: section.id, collection: true,
    title: section.label + " for AI coding sessions | ACC", description: section.description,
    breadcrumbs: [{ label: section.label }] }, breadcrumbs([{ label: section.label }])
    + '<div class="collection-page collection-' + section.id + '">' + renderers[section.id](section, sorted) + "</div>");
}
