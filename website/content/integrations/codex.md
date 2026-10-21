---
id: "codex"
title: "Connect Codex to Other AI Coding Sessions"
description: "Use ACC with independently opened Codex sessions. Understand CLI LocalDaemon delivery, desktop limits, hook trust, and outgoing permissions."
route: "/integrations/codex/"
type: "integration"
order: 20
status: "reviewed"
language: "en"
author: "ACC project"
lastVerified: "2026-10-21"
accVersion: "0.11.1"
evidenceLevel: "repository-review"
sources: ["acc-setup", "acc-capabilities", "codex-evidence", "acc-config"]
---

# Connect Codex to Other AI Coding Sessions

Use ACC when a Codex session needs an answer from a session you already opened in another coding client. For example, Codex can implement a service while Antigravity builds its interface, or review a change made by Kimi Code.

ACC does not replace either session with a managed worker.

## Activate hooks and verify access

~~~bash
acc install --adapter codex
~~~

Follow the activation output. In Codex, check the ACC plugin and review the installed hooks through the client's own plugin and hook interfaces. Restart the session after the trust review when required.

Installed files do not establish that hooks are active. The repository's next-turn capture is anchored at Codex CLI 0.147.0.

The session also needs access to ACC's local state. Default supported CLI permissions can receive ACC's narrowly scoped outgoing grants. Custom policies are preserved, and an active desktop sandbox may use different effective permissions.

## CLI live delivery has separate prerequisites

Experimental native delivery requires Codex 0.152.1 or newer, the supported LocalDaemon infrastructure, recorded recipient opt-in, a feature probe, and exact per-session identity checks.

Start Codex normally. ACC message delivery does not start or stop the vendor daemon. Explicit installation or separately confirmed update maintenance has its own service-preparation boundary.

A busy Codex receiver takes queued input after its current turn. Live delivery can spend tokens. On Windows, the adapter uses a different supported connection path and checks the actual service state.

## A desktop chat is a different surface

The documented Codex app surface inside ChatGPT.app uses a private app server instead of the shared CLI daemon. The repository describes next-turn hook delivery there and reports the session as embedded.

Do not infer CLI live-delivery support or effective sandbox grants for that chat. In particular, a Work Mode session can read code while lacking write access to ACC runtime state.

If status fails before it discovers a workspace, establish the permission or runtime failure before treating the roster as empty.

## Use a stable review target

An example request for a Codex reviewer:

> Review the registration change identified by the peer's ACC request. Inspect that checkout and revision, return reproducible blocking defects, and keep the review read-only.

A review of another worktree needs access to the actual patch, including any uncommitted changes.

Use [client compatibility](/compatibility/) to select a receiving mode and [the review guide](/guides/code-review-between-ai-clients/) to complete the request, verdict, and verification loop.

## Sources

- [ACC setup](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/GETTING_STARTED.md)
- [ACC capability evidence and limits](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/CAPABILITIES.md)
- [ACC Codex compatibility captures](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/packages/adapter-codex/COMPATIBILITY.md)
- [ACC configuration and permission boundaries](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/CONFIGURATION.md)
