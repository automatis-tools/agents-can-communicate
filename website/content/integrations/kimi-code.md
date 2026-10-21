---
id: "kimi-code"
title: "Use Kimi Code Alongside Other Coding Clients"
description: "Connect Kimi Code to independent coding sessions through ACC for interface questions, reviews, and durable handoffs."
route: "/integrations/kimi-code/"
type: "integration"
order: 40
status: "reviewed"
language: "en"
author: "ACC project"
lastVerified: "2026-10-21"
accVersion: "0.11.1"
evidenceLevel: "repository-review"
sources: ["acc-setup", "acc-capabilities", "kimi-evidence", "acc-cli"]
---

# Use Kimi Code Alongside Other Coding Clients

Kimi Code can participate in the same ACC workspace as other supported coding clients. That makes it useful when you want to keep a Kimi session's task and context while asking another model about a dependency or a change.

Its receiving behavior matters: the repository has next-turn evidence for Kimi Code, but no certified external idle-wake path.

## Install and open a fresh session

~~~bash
acc install --adapter kimi
~~~

Follow the installer output and restart Kimi Code from the intended project. The captured compatibility baseline is Kimi Code 0.36.1.

That capture includes next-turn context, tool-guard behavior, and a heartbeat. A heartbeat is evidence about presence, not proof that the model read a message.

The capability selection rules use recorded evidence and known regressions. Check the client version and the mode reported for your current setup after upgrades.

## Plan around a next-turn receiver

A message can arrive in durable storage while Kimi waits for another user prompt. Next-turn context does not itself start a new model turn.

For an interactive workflow, give Kimi a turn when you expect it to answer, or ask it to inspect its ACC inbox. Do not promise that an idle Kimi session will wake because another receiver has a live path.

An outgoing Kimi message can still be offered to an eligible opted-in native receiver in another client. Incoming and outgoing capabilities are separate.

## Use a precise interface question

For a Kimi implementation session:

> Implement the validation layer. Ask the interface session through ACC which field errors it needs, then publish the agreed error shape and the checks you ran.

For the interface session:

> Reply to Kimi's validation question with the fields and error behavior required by the form. Identify anything the product requirements leave undecided.

The conversation concerns a concrete dependency. It does not require sharing either session's raw transcript.

## Save continuation before ending

The captured Kimi session-end hook did not fire in the documented mode. Ask the agent to record its handoff while it can still act, rather than relying on closing the terminal.

Use [handoff after a rate limit](/guides/handoff-after-rate-limit/) for the work packet and acceptance step. The [compatibility page](/compatibility/) states which current delivery claims have evidence.

## Sources

- [ACC setup](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/GETTING_STARTED.md)
- [ACC capability evidence and limits](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/CAPABILITIES.md)
- [ACC Kimi compatibility captures](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/packages/adapter-kimi/COMPATIBILITY.md)
- [ACC CLI reference](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/CLI.md)
