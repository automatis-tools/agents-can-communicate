---
id: "antigravity"
title: "Use Antigravity with Other AI Coding Clients"
description: "Connect Antigravity CLI or desktop conversations to independent coding sessions through ACC, with delivery expectations for each surface."
route: "/integrations/antigravity/"
type: "integration"
order: 30
status: "reviewed"
language: "en"
author: "ACC project"
lastVerified: "2026-10-21"
accVersion: "0.11.1"
evidenceLevel: "repository-review"
sources: ["acc-setup", "acc-capabilities", "antigravity-evidence", "acc-config"]
---

# Use Antigravity with Other AI Coding Clients

An Antigravity session can work on one part of a feature while another coding client implements the service, reviews a change, or continues unfinished work. ACC adds a local communication channel between those independently opened sessions.

Choose the Antigravity surface first. The CLI and desktop app have different live-delivery paths.

## Antigravity CLI

~~~bash
acc install --adapter antigravity
~~~

Follow the installer instructions and start a fresh CLI session with an open project workspace. ACC's captured CLI hooks provide context before a model invocation; a session without an open workspace can register nothing.

Experimental live delivery uses a relay the agent starts from its own shell. That shell holds the session endpoint unavailable to ordinary hook processes. The installed instructions explain the relay, and current setup can allow ACC commands under the client's approval rules. Windows has its own relay transport and permission-prompt behavior.

The CLI evidence starts at 1.2.7. Print mode and the first session in a folder trusted during that launch have documented relay limitations. Use the actual receiving mode reported for your session.

## Antigravity desktop

The desktop app runs hooks through its language server. The captured desktop 2.19.1 live path uses that server directly, so the agent does not start the CLI relay.

A reopened conversation becomes reachable again from its next turn after the app restarts. Desktop installation and command grants also have their own requirements. The current integration setup still uses Antigravity CLI to read hook registration back.

CLI support alone is therefore insufficient evidence for a desktop claim.

## Give it a useful cross-client dependency

For an Antigravity interface session:

> Build the registration form. Ask the service session through ACC for the request, response, and validation-error contract. Return any interface requirement that changes that contract.

Have the service session answer in the same thread. These are example instructions, not a recorded product run.

ACC does not give Antigravity a certified tool write guard. Agree on editing boundaries even when another client's claims can be guarded.

Use [separate worktrees](/guides/ai-agents-git-worktrees/) for separate checkouts, and read [delivery behavior](/guides/message-delivery/) before expecting an idle session to act. The [compatibility matrix](/compatibility/) keeps CLI and desktop evidence visible.

## Sources

- [ACC setup](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/GETTING_STARTED.md)
- [ACC capability evidence and limits](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/CAPABILITIES.md)
- [ACC Antigravity compatibility captures](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/packages/adapter-antigravity/COMPATIBILITY.md)
- [ACC configuration and permission boundaries](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/CONFIGURATION.md)
