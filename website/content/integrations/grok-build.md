---
id: "grok-build"
title: "Use Grok Build with ACC Through Its Durable Inbox"
description: "Connect a Grok Build session to ACC without assuming automatic peer-message injection or idle wake. Learn the explicit inbox workflow."
route: "/integrations/grok-build/"
type: "integration"
order: 60
status: "reviewed"
language: "en"
author: "ACC project"
lastVerified: "2026-10-21"
accVersion: "0.11.1"
evidenceLevel: "repository-review"
sources: ["acc-setup", "acc-capabilities", "grok-evidence", "acc-cli"]
---

# Use Grok Build with ACC Through Its Durable Inbox

Grok Build has an ACC integration, but its current evidence is narrower than a full automatic receiving path. Use it for explicit ACC participation and inbox reads.

The installed-client check on Grok 1.0.24 observed the session's own CLI identity after a terminal result, followed by owned coordination commands. It did not certify peer-context injection, a write guard, or an external wake.

## Install the integration

~~~bash
acc install --adapter grok
~~~

Follow the installer instructions and open a new Grok session in the intended project.

The installed skill starts with public status because of the observed timing of Grok's own identity header. A session must use its own owner context for owned operations. A participant visible in the roster is not a credential that another session may borrow.

## Make inbox inspection part of the task

An example prompt:

> Check your ACC inbox for the registration review request. Retrieve the relevant message, inspect the named change, and reply with reproducible defects or a clear statement that you found none. Keep this review read-only.

Listing inbox headers is different from retrieving a complete message. The installed skill tells the agent how to fetch the selected body and answer in its thread.

This workflow requires the session to act. It does not claim that an incoming request starts a Grok turn automatically.

## Use it for a bounded second opinion

Grok can be the review session while another client owns implementation. The sender should identify the exact revision and checkout.

When Grok returns a finding, the implementation session verifies the behavior before changing code. The response resolves a communication obligation, not the repository's review requirements.

Outgoing sends may use an eligible recipient's opted-in native adapter. That does not add an incoming live capability to Grok.

## Diagnose without overstating support

A successful installation or an observed own-identity header is insufficient evidence that peer messages enter the model context. Documentation-shaped hook payloads are also insufficient evidence of real client behavior.

The [compatibility matrix](/compatibility/) therefore lists Grok's normal receiving path as explicit inbox retrieval. For the full request and verdict cycle, use [independent code review](/guides/code-review-between-ai-clients/).

## Sources

- [ACC setup](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/GETTING_STARTED.md)
- [ACC capability evidence and limits](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/CAPABILITIES.md)
- [ACC Grok compatibility captures](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/packages/adapter-grok/COMPATIBILITY.md)
- [ACC CLI reference](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/CLI.md)
