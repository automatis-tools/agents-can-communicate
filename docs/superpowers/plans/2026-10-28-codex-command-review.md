# Codex Command Review Implementation Plan

> For agentic workers: use superpowers:executing-plans. The user requested inline completion; working documents remain internal.

**Goal:** Prevent avoidable ACC reviews and preserve accurate local context when approval is required.

**Architecture:** Keep the participant rule. Use default permissions first and operation-specific justification on sandbox retries. Test the installed wrapper through a real Codex tool loop.

**Tech Stack:** Node ESM, node:test, Codex 0.165.0, a local Responses fixture.

**Spec:** ../specs/2026-10-28-codex-command-review-design.md

## Global Constraints

- No global permission expansion, reviewer policy change, merge, or ready transition.
- Preserve operator edits and existing send idempotency keys.
- Synthetic endpoint evidence is not proof of an OpenAI model's judgment.

## Review Focus

- Missing rules must not produce false success under a sandbox.
- State access must be checked outside workspace and writable temporary roots.
- Justification must appear in the exact reviewed action, not only earlier prose.
- Reviewer denial must leave execution effects absent.
- Old generated rule comments must remain owned; edited rules remain the operator's.

## Tasks

- [ ] Add failing installed-guidance and diagnostic tests.
- [ ] Add a local scripted model helper and native Codex command acceptance test.
- [ ] Observe the tests fail with current skill and diagnostics.
- [ ] Change skill, rule diagnostics and comments, with exact legacy ownership recognition.
- [ ] Exercise default, escalation, denial and missing-rule cases through the installed package.
- [ ] Update current docs and record the measured evidence and its limits.
- [ ] Run syntax, full suite, package verification and mutation checks.
- [ ] Obtain independent review, resolve findings, commit, push and create a draft PR.
