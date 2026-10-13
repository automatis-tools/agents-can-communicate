# When Codex and Claude Code Need to Talk

One technical talk, one objective, one master deck. Mykola presents as the independent
creator of ACC. The goal is to find builders who try one real dependency across two
independently opened coding clients and report where they still need human help.

## Deliverables

- `deck.html`: self-contained browser presentation, usable offline. Select the route
  with `?length=6`, `?length=20`, or `?length=35`. The default is 35 minutes.
  Arrow keys advance, Home/End jump, N reveals private speaker notes, F requests fullscreen.
  Browser Print prints only the selected route. No external fonts, scripts, or analytics.
- `acc-talk.pdf`: the same sixteen slides, exported from the 35-minute route, for
  sharing with organizers. The HTML remains the editable source with speaker notes.
- `speaker-script.md`: full spoken body, the six-minute cut, transitions, timing and Q&A.
- `demo-runbook.md`: native-client scenario, rehearsal checks, and honest fallback.
- `demo.mjs`: executable protocol replay against the real CLI in a disposable workspace.
- `proposals.json`: common title, goal, reusable bio/abstract, and exact technical fields
  for both applications. Contact details and a headshot are deliberately outside this repo.
- `evidence.md`: source map and the distinction between historical captures and this kit's
  current verification. No new client capability is claimed by these materials.

From the checkout root, after `npm ci`:

```bash
node docs/talks/acc/demo.mjs --step
```

To present, open `deck.html` in a browser. A local preview can also use a static server
bound to `127.0.0.1`; the presentation itself needs no server or network.

## Formats

| Route | Slides | Running content | Q&A |
|---|---|---|---|
| 6 minutes | 1, 3, 5, 16 | One bounded exchange, receipt semantics, experiment | Organizer-controlled |
| 20 minutes | 1–6, 9, 10, 14, 16 | Workflow plus transport and verification lessons | Additional time if offered |
| 35 minutes | All 16 | Workflow, replay, source tour, reliability and performance | 10 minutes at TESTINGMIND |

Timings are rehearsal targets, not a measured speaking duration. The full script allocates
time for the live exchange, replay and source inspection. Do not fill that time by reading
every sentence on every slide.

## Event record, checked 2026-10-12 America/Toronto

| Event | Actual requirement | Application state when inspected |
|---|---|---|
| AI Tinkerers Toronto, Oct 13, 17:00–20:00 EDT | Six-minute running-code demo, few slides, no pitch | Form available, attendee waitlist. CFP deadline Oct 5, decisions Oct 8. Late submission |
| AI Engineering Summit Toronto, Oct 29 | Track Talk, 35 minutes plus 10 Q&A | General CFP form available. Mandatory personal fields and business-formal headshot |

The generic AI Tinkerers form says 15–20 minutes. The event's own six-minute call takes
precedence for this proposal. Form availability does not prove that a slot remains.
No TESTINGMIND CFP deadline was shown on the inspected general CFP page.

Sources: [Toronto event](https://toronto.aitinkerers.org/p/ai-tinkerers-toronto-october-2026-meetup-hosted-by-shopify),
[Toronto proposal form](https://toronto.aitinkerers.org/meetup/mu_FefpJagWemc/speaking),
[TESTINGMIND CFP](https://www.testingmind.com/event/cpf-aiengineering-summit/),
[TESTINGMIND event listing](https://www.testingmind.com/event/).

## Reuse after each event

Keep the title, central workflow, and learning objective. Refresh the source baseline and
client versions, rehearse the native path, and retain only observed evidence. Change the
application abstract to the venue's length and emphasis. Avoid claiming past acceptance
or speaking experience until it happens.

Record attendee questions and technical feedback without adding personal contact details
to the public repository. Useful feedback includes client/version/platform, the dependency
being coordinated, recorded/receipt facts, and the step requiring human intervention.
Link a redacted issue or discussion after a conversation, only when invited. The stage
close contains a plain repository reference, with no signup QR code or sales offer.
