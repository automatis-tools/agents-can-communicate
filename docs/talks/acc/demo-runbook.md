# Demo runbook

## What the audience must see

Two sessions opened independently by the presenter, each working under its own instructions.
A UI agent needs an API contract, asks its peer through ACC, receives a concrete answer,
and uses it. The presenter inspects the same message's receipts. A reply proves an answer,
and the resulting artifact establishes what work actually happened.

This native-client workflow is a rehearsal recipe. The kit's automated replay validates
the CLI protocol using synthetic participants. It does not execute this model workflow,
certify native delivery, or establish that two models will behave consistently on stage.

## Prepare before the event

Use a dedicated disposable project outside the ACC repository. Keep any real project or
private conversations off the projector. Do not use this preparation session's owner
credentials in the demo. Each native session uses the pair supplied by its own hook.

The fixture needs Node 24+, installed ACC, and current trusted Claude Code and Codex
integrations. Run `acc version` and `acc doctor` in the demo directory, and record the exact
client versions and observed delivery mode. Use the ordinary client launch command.
If native delivery is already opted in, verify that both sessions have a current binding.
An install command or a supported version does not prove activation. Do not switch consent,
client services or permissions during the stage demo.

Start each client normally from this directory. Ask each to publish its work and claim its
own files using its installed ACC skill. Both must appear in `acc status`. Use two panes
with 24–28 pt terminal text and a visible transcript limited to this fixture. Suppress
notifications. Present the plain project and selected source files, not account settings,
runtime binding files, real inbox history or environment dumps.

## Fixed scenario

Codex prompt:

> In this disposable demo, define a registration API contract in api/contract.md. The
> request has email and password. A duplicate email returns status 409 with
> { "code": "EMAIL_TAKEN" }. Claim only file:api/**. Publish your intent through ACC.
> Remain available to answer a peer's question about the contract. Read your own inbox
> when asked and reply using ACC. Keep answers concise. Do not implement a server.

Claude Code prompt:

> In this disposable demo, create ui/registration-example.md with a sample request and
> the duplicate-email handling for a registration form. Claim only file:ui/**. Publish
> your intent through ACC. Before selecting the request and error fields, ask the Codex
> peer through ACC for the contract. Read its answer and use the exact fields. Do not
> invent an answer if no reply arrives. Do not implement a web application.

These prompts ask for a bounded artifact rather than waiting for an entire application
build. The sender chooses an unambiguous current participant from the roster. Do not
address a role label as if it were a routable participant.

## On stage, maximum 2:30 in the six-minute route

1. **0:00–0:20:** show the two intents and separate file scopes.
2. **0:20–1:15:** submit the UI prompt. Show the addressed contract question and its id.
3. **1:15–1:50:** show the peer's answer and `ui/registration-example.md` using the same
   request and error fields. If the client takes only next-turn delivery, explicitly
   ask its agent to read its own inbox. Name that manual step for the audience.
4. **1:50–2:15:** ask the sender to inspect exact history for that message. Name the
   recorded receipt facts without claiming model attention or task completion.
5. **2:15–2:30:** return to the receipt slide. If the exchange has not completed, stop
   waiting and show the CLI fallback. Do not repeatedly nudge a model during the talk.

The 35-minute route allows five minutes for this same scenario and three minutes for
the replay/source inspection. Additional time explains the observed boundaries rather
than expanding the task.

## Reliable fallback, no model credentials

```bash
node docs/talks/acc/demo.mjs --step
```

The script uses the checkout's real CLI, creates two synthetic manual participants in a
non-Git directory, and puts its runtime store in a new OS temporary directory. It scrubs
inherited ACC identity/settings, disables update checks, sets subprocess deadlines,
asserts each fact, and removes only the fixture it created in `finally`.

Say: “This is the same protocol through the real CLI, with synthetic participants. It
shows the transport semantics. It does not show a model noticing or acting on a message.”

It shows an overlapping advisory claim refusing a second reservation, durable recording,
an equivalent retry returning the original id, header listing keeping a receipt queued,
exact retrieval, and a reply acknowledging the original. It intentionally skips `offered`
because no native transport or next-turn hook participates.

For the installed artifact, pass the absolute packed CLI entrypoint:

```bash
node docs/talks/acc/demo.mjs --cli /absolute/path/to/consumer/node_modules/agents-can-communicate/bin/acc.mjs
```

Use `--evidence /absolute/path/outside/the/checkout/replay.json` for a concise capture.
`--step` is interactive. Without it, the assertions run unattended. Evidence records only
synthetic facts, not owner generation credentials or model transcripts.

## Ready-to-present checks

- Run the exact selected deck route and verify projector-size readability.
- Complete the bounded native exchange once on the stage machine and inspect its artifact.
- Run the fallback with the exact CLI to be used on stage.
- Keep that CLI/deck locally available if Wi-Fi or a provider fails.
- For every captured example label client version, date, source and what it proves.
- Rehearse aloud with a stopwatch. Cut content to fit the slot instead of increasing speed.

Native delivery may spend model tokens. The presenter chooses consent beforehand. ACC
does not remove the providers' network requirement, make models deterministic, or make
peer text trusted. Claims are advisory unless a relevant certified guard is requested
and available. A rejected claim does not prevent an unrelated program editing a file.

After the demo, close the native sessions normally and archive only useful redacted
evidence. Remove the fixture artifacts you own when no longer needed. Preserve other
sessions, installations and current presentation material.
