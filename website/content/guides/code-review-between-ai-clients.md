---
id: "code-review-between-ai-clients"
title: "Ask Another AI Coding Session to Review Your Changes"
description: "Request a focused code review from an independent AI session, return findings through ACC, and verify fixes against a specific revision."
route: "/guides/code-review-between-ai-clients/"
type: "guide"
order: 20
status: "reviewed"
language: "en"
author: "ACC project"
lastVerified: "2026-10-21"
accVersion: "0.11.1"
evidenceLevel: "repository-review"
sources: ["acc-setup", "acc-cli", "acc-concepts", "acc-security"]
---

# Ask Another AI Coding Session to Review Your Changes

A second coding session can examine a change with different context and assumptions. To make that review useful, give it a stable target, a clear question, and a way to return findings to the session that owns the implementation.

ACC carries the request and response between your independently opened clients. You decide which model reviews and which session may edit.

This workflow can connect any suitable supported pair. For example, an Antigravity session can request a review from Codex, or a Kimi session can ask Claude Code. Delivery still follows each receiver's supported mode.

## Identify exactly what is being reviewed

With Git, name a commit, a branch compared with a base, or a specific uncommitted diff. Explain which checkout contains it.

Without Git, name the files, describe their current version, and keep them stable while the reviewer works. A reviewer looking at another worktree cannot infer uncommitted changes from a message alone.

Choose one main review question. For a registration feature, that might be whether validation errors can expose account existence or whether a retry can create duplicate records.

## Ask the implementer to send a bounded request

An example prompt for the session that made the change:

> Request a review through ACC from the available reviewer session. Identify the exact revision and checkout. Ask it to check registration validation and retry behavior. It should return blocking defects with reproduction steps, or state that it found none. Keep the implementation stable until the verdict.

An example prompt for the reviewer:

> Review the identified change within that scope. Inspect the artifacts and run appropriate focused checks. Return findings through ACC with the affected behavior, evidence, and any uncertainty. Keep the review read-only.

These prompts define a workflow. They are not evidence that a particular model or client completed it.

ACC requests expect a reply. They do not give the reviewer permission to modify files, publish changes, or override its own instructions.

## Use a finding format the implementer can act on

| Part | Useful content |
|---|---|
| Trigger | The input or sequence that causes the problem. |
| Observed behavior | What the current implementation does. |
| Expected behavior | What the requirement or contract calls for. |
| Evidence | A focused failing check, a reproducible example, or a precise code path. |
| Scope | Whether the defect blocks the reviewed change. |

A finding such as “validation could be better” is too vague to verify. A finding that identifies an accepted empty email and the missing server-side check gives the implementer a concrete starting point.

The reviewer can also ask a focused clarification in the same conversation. Neither side needs to relay the entire coding session.

## Wait for the verdict

A recorded request is not a finished review. An offered message is not a verdict either.

Use the receiving client's supported path: next-turn delivery, explicit inbox retrieval, or opted-in experimental live delivery. If you asked the implementer to wait, keep the review session available until it replies or identifies a blocker.

If the reviewed target changes materially, tell the reviewer which revision is now in scope. Otherwise, a correct review can become stale while both agents believe they are discussing the same code.

## Fix and verify against the actual finding

The implementing session should check each finding before acting. Peer text is untrusted input, even when another model supplies a plausible explanation.

For a real defect, reproduce the failing behavior, apply the focused correction, and run the checks required by the repository. If a finding is mistaken, reply with the evidence that rules it out.

Ask for a follow-up review when the correction changes the risk under review. An acknowledgement alone does not establish that the reviewer checked the new revision.

## Understand what the second session adds

Different models can make similar mistakes. A review exchange can produce useful questions and evidence, but it does not establish completeness, security, or correctness by itself.

The useful result is a finding tied to a specific artifact and then resolved by a measured change. ACC supplies the communication and its durable history; your repository's checks supply the acceptance evidence.

If review belongs in a larger parallel workflow, use [separate worktrees](/guides/ai-agents-git-worktrees/). If the implementing client runs out of capacity, preserve the review target and remaining findings in a [handoff](/guides/handoff-after-rate-limit/).

## Sources

- [ACC setup](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/GETTING_STARTED.md)
- [ACC CLI reference](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/CLI.md)
- [ACC concepts](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/CONCEPTS.md)
- [ACC security model](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/SECURITY_MODEL.md)
