---
id: "installed-artifact"
title: "Test the package people actually install"
description: "How ACC checks its packed npm artifact, why source-tree tests are insufficient, and how mutation controls establish that a gate catches a defect."
route: "/reports/installed-artifact/"
type: "report"
order: 10
status: "reviewed"
language: "en"
author: "ACC project"
lastVerified: "2026-10-21"
accVersion: "0.11.1"
evidenceLevel: "verification-method"
---

# Test the package people actually install

A development checkout can hide a packaging mistake. Workspace links make a module available, local files satisfy an import, and a test passes. The person installing the published package has none of those conveniences.

ACC therefore checks the packed artifact in a separate installation. This report describes the verification method; it does not certify a new release or a new client version.

## Start from the tarball

The package verifier installs the candidate archive in a clean directory outside the workspace. It then exercises the commands and integrations that depend on the files actually shipped.

That boundary catches a different class of defect from a source-level unit test. A module can work correctly and still be absent from the package. A documented command can be valid in development while an installed hook points to a missing entry point.

The artifact under test must be the archive intended for release. Repacking changed files produces a different candidate.

## Keep the source and evidence together

Release records identify the commit supplying the packed bytes, the archive hash, the verification result, and the scope of client captures.

An archive hash identifies an artifact. It does not establish that the currently installed client activated its hooks. A native-client capture establishes behavior under the recorded version and conditions, rather than every later combination.

These distinctions prevent a healthy process or a successful import from becoming a broader product claim.

## Prove that the check can fail

A green test is useful only if the relevant defect would make it fail. Mutation controls introduce the exact mistake a gate is meant to catch.

For a package boundary, remove or redirect a required file. For a delivery contract, alter the transition or recipient selection under test. Observe the failure, restore the candidate, and verify it again.

The goal is a check sensitive to the promised behavior. A test that only repeats the implementation's current answer cannot supply that evidence.

## Preserve the limits

Automated protocol tests, installed-package checks, synthetic client fixtures, and captures from a real client answer different questions.

Passing one category does not substitute for another. In particular, a synthetic model or transport can establish an integration path without establishing the quality of a real model's response.

For the reader, the useful report is explicit about its artifact, conditions, observed result, and remaining uncertainty.

## Sources

- [ACC release and artifact-verification procedure](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/docs/RELEASING.md)
- [Repository verification contracts](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/AGENTS.md)
- [Installed-package verifier](https://github.com/automatis-tools/agents-can-communicate/blob/8bfb53f35d8692fdc5f02adf947b69eb26a68294/scripts/verify-package.mjs)
