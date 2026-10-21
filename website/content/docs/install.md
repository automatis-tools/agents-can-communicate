---
id: "install"
title: "Install ACC"
description: "Install Agents Can Communicate on macOS, Linux, or Windows, activate your coding-client integrations, and check the first connection."
route: "/docs/install/"
type: "doc"
order: 10
status: "reviewed"
language: "en"
author: "ACC project"
lastVerified: "2026-10-21"
accVersion: "0.11.1"
evidenceLevel: "repository-review"
---

# Install ACC

You need Node.js 24 or newer and two supported coding clients on the same machine, under the same operating-system user. ACC runs on macOS, Linux, and Windows 10 or 11.

## Install the package

~~~bash
npm install -g agents-can-communicate
acc install
~~~

The installer connects the supported clients it finds. Follow its activation instructions, including any client-side hook or plugin trust review. Restart your clients from the project directory so they load the integration.

For Codex, check that ACC is enabled in the plugin interface and review its hooks. Client permissions and desktop sandboxes can differ; an installed file alone does not establish that the integration is active.

## Open two sessions

Give each session its ordinary part of one feature. For example, ask one to build a registration endpoint and the other to build the form that calls it.

Supported integrations introduce peers and teach agents how to communicate. The agents decide when a dependency needs a conversation.

For a deliberate first exchange, ask the form session to request the service's input and response shape through ACC. Ask the service session to answer with the current contract.

The [connection guide](/guides/connect-ai-coding-sessions/) walks through discovery, the question, and a useful answer.

## Check what is available

~~~bash
acc status --json
acc doctor
~~~

Check the actual participants and delivery mode. Some clients receive messages at their next turn; others use explicit inbox access. [Client compatibility](/compatibility/) explains the differences.

Experimental live delivery is a separate opt-in. It can start a model turn and spend tokens. You can begin with ordinary next-turn or inbox delivery.

## Keep control of updates

Initial installation enables automatic updates. To update manually or disable automatic checks:

~~~bash
acc update
acc update --auto off
~~~

Use the [upgrade reference](https://github.com/automatis-tools/agents-can-communicate/blob/main/docs/UPGRADING.md) for existing stores and client-service maintenance.

## Remove ACC

~~~bash
acc uninstall
~~~

The uninstaller removes owned integrations while preserving user edits. Your coding clients keep their own provider access and configuration.

## Sources

- [Installation and client activation](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/GETTING_STARTED.md)
- [Update and uninstall controls](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/UPGRADING.md)
