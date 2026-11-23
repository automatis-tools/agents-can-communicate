# Doctor asks Codex whether ACC's hooks run: development evidence

This records the development candidate for #427. It is not a published release.

## What was seen

On 2026-11-22, after the maintainer's Mac updated from 0.15.1 to 0.15.2, `acc doctor` still
printed "hook readiness unverified: open codex; check ACC is enabled in /plugins; in /hooks,
review each ACC hook ...". The running Codex 0.171.0 daemon's `hooks/list` reported all five
ACC hooks of `agents-can-communicate-hooks@acc-local` as `enabled` and `trusted`, for the home
directory and for a project directory.

## Exact artifact

- Source: clean commit `7378ddb5830d8e7a55d9c7faeab1cf933cb1d862`.
- Archive: `agents-can-communicate-0.15.2.tgz`, 661,533 bytes, 392 files.
- SHA-256: `8ab958604689f17f9bcfed90e548537954416054cd1b7485fb9129f3189bcad6`.
- Node 24.4.0, npm 11.4.2, macOS arm64.

The exact archive passed `scripts/verify-package.mjs`.

## Behaviour covered by tests

- With Codex's answer that every installed event runs, detection reports "Codex reports ACC's
  hooks enabled and trusted" and asks for no hook review. It asks for the events of the
  installed `hooks.json`, of the Codex home it reads.
- A hook Codex would not run is named with its state, and the review stays.
- No answer, a failed read or a partial answer leaves the "unverified" review; so does an
  unreadable `hooks.json`, and then Codex is not asked.
- Against the fixture daemon: `hooks/list` decides each hook (`not listed`, `untrusted`,
  `disabled`, `managed` runs, another plugin's hook is ignored). A failed list, an unproven
  process, a socket the process does not hold and a stopped daemon each give no answer, and
  no service is started.
- The two tests that expect a changed doctor fail on the previous `install.mjs`.

## Installed run

The exact archive was installed with `npm install -g` into an isolated prefix and npm cache.

1. With the real home and an empty ACC data home, `acc doctor --json` reported for Codex:
   "Codex reports ACC's hooks enabled and trusted: sessionStart, userPromptSubmit, preToolUse,
   stop, sessionEnd", and its remediation held no hook review. Codex's `config.toml` kept its
   modification time.
2. In an isolated home with ACC installed for Codex and no Codex service, doctor printed the
   previous "hook readiness unverified" review.

## Limits

- The case where Codex reports an untrusted or modified ACC hook was covered by tests and the
  fixture daemon only; the real daemon trusted all five hooks.
- Windows and Linux ran in CI only.
