---
id: "ai-agents-git-worktrees"
title: "Coordinate Different AI Coding Agents Across Git Worktrees"
description: "Use separate Git worktrees for parallel coding sessions and ACC to discuss dependencies, edit boundaries, and integration of the results."
route: "/guides/ai-agents-git-worktrees/"
type: "guide"
order: 30
status: "reviewed"
language: "en"
author: "ACC project"
lastVerified: "2026-10-21"
accVersion: "0.11.1"
evidenceLevel: "repository-review"
sources: ["acc-concepts", "acc-cli", "acc-setup", "acc-security"]
---

# Coordinate Different AI Coding Agents Across Git Worktrees

Git worktrees give coding sessions separate checked-out files. They do not tell the sessions which interface another branch is changing or which assumptions need agreement.

Use ACC to discuss those dependencies while each client stays in its own checkout. Worktrees of one repository share an ACC workspace, while ACC retains each session's checkout information.

You still choose the work, the integration order, and the repository gates.

## Split around a real boundary

A useful split gives each session a result another person could review independently:

| Session | Owns | Needs from the peer |
|---|---|---|
| Service | Registration endpoint and validation | Required fields and expected interface behavior. |
| Interface | Registration form and error display | Request shape, response shape, and failure cases. |
| Reviewer | Read-only examination of a named revision | An exact target and a review question. |

Different worktrees help isolate edits. They cannot isolate assumptions about a shared contract. Agree on that contract early enough that both sides can implement against it.

Use your existing repository process to create the worktrees and branches. ACC does not require or create them for this workflow.

## Open each client in its assigned checkout

Install ACC once, activate the integrations, and start each client normally from its worktree.

From either checkout, inspect the public roster:

~~~bash
acc status --json
~~~

Check that the expected participants share the room and that their checkout information matches the intended work.

A session keeps the room selected at startup. Moving its shell into another directory does not automatically move the conversation into a different ACC room. Start sessions from the intended project or use the documented workspace configuration.

## Publish intent before editing

Ask each coding session to state what it is doing and which resources it expects to change. The installed coordination skill can publish that intent.

For example:

> Work on the registration service only. Publish your scope in ACC, check for overlapping work, and ask the interface session about the fields it needs before fixing the contract.

A resource hint helps another session notice a possible overlap. It does not reserve anything.

When the workflow calls for a reservation, the agent can make a claim for the smallest useful resource. An overlapping claim requires the peers to narrow their scopes, agree on a handoff, or wait.

## Treat claims as coordination facts

ACC claims are advisory unless the relevant clients and paths meet the measured requirements for guarded enforcement.

A guarded claim still cannot stop an unrelated editor or every way a process might write a file. Antigravity has no certified tool write guard in the current matrix, and generic MCP clients do not acquire one by connecting.

The claim therefore belongs in the conversation about who changes what. It is not a guarantee that branches cannot conflict.

## Share decisions when they become dependencies

A good interface message describes the agreed contract and points to the artifact where it is implemented:

> Registration accepts email and password. Validation errors are keyed by field. The service checkout contains the implementation. The interface can proceed against that shape; password reset remains outside this change.

If the contract changes, send the correction explicitly. ACC also supports recording superseded or withdrawn decisions, so an older position can remain attributable without being presented as current.

A current recorded decision is still a peer's position. Validate it against the actual project requirements.

## Integrate deliberately

A message can say that a commit is ready. It does not merge the commit, transfer uncommitted files, or verify that another branch remains compatible.

Have each session report the artifact, checks run, and unresolved concerns. Follow the repository's integration process to bring changes together, then run the combined checks.

If one agent must stop, use a [handoff](/guides/handoff-after-rate-limit/) that names its worktree, committed and uncommitted state, and remaining integration steps.

The result is separate working copies with a shared conversation about dependencies. You retain the same Git workflow and the authority to decide what lands.

## Sources

- [ACC concepts](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/CONCEPTS.md)
- [ACC CLI reference](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/CLI.md)
- [ACC setup](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/GETTING_STARTED.md)
- [ACC security model](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/SECURITY_MODEL.md)
