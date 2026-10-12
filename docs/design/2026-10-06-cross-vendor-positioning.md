# Public texts for the cross-vendor position

Date: 2026-10-06. Ships in 0.10.0.

## Problem

Both large vendors now carry messages between their own sessions:

- Claude Code has cross-session messaging from 2.1.224 (2026-08-07), on by default
  ([documentation](https://code.claude.com/docs/en/cross-session-messaging)).
- Codex has `codex queue` from 0.149.0 (2026-08-20). Codex 0.160.1 describes it as "Queue a
  message for an existing session" (`codex queue --help`, checked 2026-10-06).

Each reaches only its own sessions. They differ: Claude Code's is a tool the model calls on
its own, and it also reaches sessions on other machines and in the cloud; `codex queue` is a
command a person or a script runs, and Codex's agent message board serves one session's own
team of sub-agents. Claude Code also documents its inbox socket for scripts and hooks.

The README still opened with "Let your AI coding sessions talk to each other", which promises
a single-vendor reader what the client already does. The part neither vendor covers is between
vendors on one machine: neither client offers a way to message the other's sessions.

## Decision

Every public text leads with that gap and names the vendor features as given:

- **Headline.** "The message your clients can't send each other." The first paragraph says
  what Claude Code and Codex each do, that neither offers a way to message the other's
  sessions, and that ACC carries
  questions, reviews and handoffs between sessions in different vendors' clients, locally. It
  says "carries", never "wakes": live delivery stays opt-in and is described further down.
- **One vendor.** A reader whose sessions all run in Claude Code, or all in Codex, is told to
  try the client's own messaging first. The texts say "neither client offers a way to message
  the other's sessions", never "they cannot reach each other": a script can post into a
  Claude Code socket or run `codex queue`.
- **Scenarios**, in this order: a second opinion from another vendor's model; parallel
  features in different clients; a switch of clients mid-feature. The first-run example is a
  review: Claude Code asks a Codex session to review its change and gets the findings back.
- **Clients.** Gemini CLI leaves the README, the diagram, the package keywords and the GitHub
  topics; Google is retiring it in favour of Antigravity CLI. Its integration and its
  certification stay, and `docs/CAPABILITIES.md` keeps describing them.
- **Feedback.** The README sends people to issues, with first-run and bug templates; the
  first-run template asks how the person found ACC. A person whose first run worked is asked
  to watch releases. Discussions stay for longer write-ups.
- **Why not an MCP server or a script.** `docs/WHY_ACC.md` answers both by mechanism: a model
  has to decide to call an MCP tool, while ACC's hooks bring peers and messages into the turn
  by themselves; and wiring the socket and `codex queue` by hand leaves out the shared list of
  peers, replies back to the sender's client, messages kept for closed sessions, receipts, and
  instructions in each client.

## Files

- `README.md`: headline, first paragraph, diagram, scenarios, first run, client list,
  feedback paragraph. Length stays in the same range.
- `docs/WHY_ACC.md`: opening, the "Does it fit?" chart (it now starts with vendors), the MCP
  answer, and the one-vendor case under "Choose another layer when".
- `docs/index.md`, `docs/GETTING_STARTED.md`: their first sentence.
- `package.json`: description and keywords.
- `.github/ISSUE_TEMPLATE/`: `first-run.yml`, `bug.yml`, `config.yml`.
- GitHub About and topics: set by the maintainer's decision, after the merge.

## Limits

- The first paragraph is the one statement that depends on other products. If Claude Code or
  Codex gains a native path to the other vendor's sessions (for example A2A), the position
  changes, and the monthly review checks for it.
- Published articles and posts are not edited.
- Words the texts avoid: first, only, any client, any session, instantly.

## Addendum 2026-10-08: OpenAI's Codex plugin for Claude Code

The 2026-10-06 check looked for A2A and for session-to-session messaging and missed a vendor
path that has existed since 2026-03-30:
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc), OpenAI's official plugin
for Claude Code. From Claude Code it offers `/codex:review` and `/codex:adversarial-review`
(Codex reviews the current changes), `/codex:rescue` (a task handed to Codex as a background
job through the Codex app server) and `/codex:transfer` (the current Claude Code session
becomes a Codex thread through Codex's external-agent session importer, with the transcript).
Codex also imports Claude Code sessions and configuration on its own, one way.

What it does not do: it starts Codex under Claude Code and never addresses a Codex session the
person opened themselves; there is no Codex → Claude Code direction. So "neither client offers
a way to message the other's sessions" stays true as written, but two of the three README
scenarios are available to a Claude Code reader from the vendor, in that direction.

Changes to the public texts, in the working copy on 2026-10-08:

- The README's first paragraph names the plugin as a vendor function, next to cross-session
  messaging and `codex queue`, and narrows the claim to "a session you opened yourself in the
  other one", "in either direction".
- The scenario order becomes: parallel work across clients; a second opinion in either
  direction; a switch of clients mid-feature, with the handoff described as decisions,
  unfinished work and what was verified, rather than a transcript.
- The first-run example changes from a review across clients to one feature across two
  clients (the endpoint-and-screen pair from the setup guide), with the review as a second
  sentence; a review alone is what the plugin does in one command.
- `docs/WHY_ACC.md` names the plugin in its first paragraph, adds a branch for it to the fit
  diagram, and mentions it in the "hooks over an MCP server or a script" section.
