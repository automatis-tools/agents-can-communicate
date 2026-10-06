# Public texts for the cross-vendor position

Date: 2026-10-06. Ships in 0.10.0.

## Problem

Both large vendors now carry messages between their own sessions:

- Claude Code has cross-session messaging from 2.1.224 (2026-08-07), on by default
  ([documentation](https://code.claude.com/docs/en/cross-session-messaging)).
- Codex has `codex queue` from 0.149.0 (2026-08-20). Codex 0.160.1 describes it as "Queue a
  message for an existing session" (`codex queue --help`, checked 2026-10-06).

Each reaches only its own sessions. The README still opens with "Let your AI coding sessions
talk to each other", which promises a single-vendor reader what the client already does. The
part nobody covers is between vendors on one machine: a Claude Code session and a Codex
session cannot reach each other.

## Decision

Every public text leads with that gap and names the vendor features as given:

- **Headline.** "The message your clients can't send each other." The first paragraph says
  what Claude Code and Codex each do, that neither reaches the other, and that ACC carries
  questions, reviews and handoffs between sessions in different vendors' clients, locally. It
  says "carries", never "wakes": live delivery stays opt-in and is described further down.
- **One vendor.** A reader whose sessions all run in Claude Code, or all in Codex, is told
  that the client's own messaging is enough.
- **Scenarios**, in this order: a second opinion from another vendor's model; parallel
  features in different clients; a switch of clients mid-feature. The first-run example is a
  review: Claude Code asks a Codex session to review its change and gets the findings back.
- **Clients.** Gemini CLI leaves the README, the diagram, the package keywords and the GitHub
  topics; Google is retiring it in favour of Antigravity CLI. Its integration and its
  certification stay, and `docs/CAPABILITIES.md` keeps describing them.
- **Feedback.** The README sends people to issues, with first-run and bug templates; the
  first-run template asks how the person found ACC. A person whose first run worked is asked
  to watch releases. Discussions stay for longer write-ups.
- **Why not an MCP server.** `docs/WHY_ACC.md` answers it by mechanism: a model has to decide
  to call an MCP tool, while ACC's hooks bring peers and messages into the turn by themselves.

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
