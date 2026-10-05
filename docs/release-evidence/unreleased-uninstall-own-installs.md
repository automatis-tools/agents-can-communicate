# Unreleased: an uninstall takes back only what its own data home installed

| Candidate artifact | Value |
|---|---|
| Built from | `bd6436eaaf946db70cff649728e6d8508de5a8cb` |
| Tarball | `agents-can-communicate-0.8.5.tgz`, 533,034 bytes, 329 files |
| sha256 | `f3963c098d6ddac3d8fe5ae1b8c4335db0d03af54f12c5fabfd654df486bdfc5` |

Fixes #253.

## What was measured before the change

ACC 0.8.5 development candidate, macOS arm64, 2026-10-05. During an e2e with an isolated
`ACC_DATA_HOME` that had installed only the Antigravity integration, `acc uninstall` without
`--adapter` removed ACC's wiring for Claude Code, Codex, Gemini CLI, Grok and Antigravity from
the operator's real client homes. Those were the main data home's installs; it kept its records
for wiring that was gone. The uninstall plan visited every client present on the machine and
read the install records only for clients that had left it.

## What changed

- `installer`: an uninstall skips a present client that the current data home has no install
  record for, and says so: "has no install record in this ACC data home, so ACC leaves it as
  it is; to remove ACC wiring another data home put there, run acc uninstall --adapter
  <client>". Naming the client keeps removing it.
- Docs: CLI and troubleshooting.

## Tests

- `packages/installer/test/uninstall-own-installs.test.mjs`: two data homes on one client home;
  an uninstall from the one that did not install leaves the other's wiring byte for byte and
  names the skipped client (seen failing before the change); naming the client still removes
  it; a data home's own install is still removed.
- Three existing tests now pass the install records into the uninstall plan, as `acc uninstall`
  always does.
- `tests/acceptance/cross-vendor-live.test.mjs`: the packed release's second uninstall used to
  visit every client as a no-op; the first one took this home's records, so it now skips every
  client by name and still changes no file. The pre-push run caught that expectation, and the
  skip line's first wording ("was not installed from this ACC data home") was wrong for it,
  so the reason now reads the same for both cases.

## End to end after the change

The packed candidate, an isolated `HOME`, two data homes, Gemini CLI present on `PATH`,
2026-10-05.

- Data home A installed the Gemini CLI integration.
- `acc uninstall` from data home B reported `uninstalled 0 adapter(s)` and a skip line for Gemini
  CLI (in the first wording, the same behaviour);
  every file in the home matched its pre-uninstall sha256.
- `acc uninstall --adapter gemini_cli` from B removed the wiring.
- After a fresh install from A, `acc uninstall` from A removed it.
