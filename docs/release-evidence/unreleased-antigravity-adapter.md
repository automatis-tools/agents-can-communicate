# Unreleased Antigravity CLI adapter and live delivery

This records the branch that adds the Antigravity CLI adapter and its live delivery
relay. Every client behaviour it relies on is a capture in
`packages/adapter-antigravity/fixtures/`, described in the adapter's
[compatibility notes](../../packages/adapter-antigravity/COMPATIBILITY.md).

## Exact local artifact

- Source: clean commit `5f3cf171bee542b929a2811c2dac7d61c67c4363`.
- Archive: `agents-can-communicate-0.5.10.tgz`, packed from that commit.
- Size: 442,881 bytes; 306 packed entries.
- SHA-256: `9187544b6bee2b169f1bb05436b3264b1cdfb9c1ff3a1f8eadd79c5d899a8e4f`.
- Package version remains `0.5.10`; this is an unpublished development artifact.

The exact archive passed `scripts/verify-package.mjs`: pack, contents with no forbidden
entries, six certification manifests with their exact evidence allowlist, packed Markdown
links, bundled workspace versions, clean installation, doctor, no-Git workspace
operations, and install/uninstall byte restoration. Syntax checks passed in 589 files.
The 107 focused Antigravity checks - adapter, relay, native delivery, relay startup and
routing, activation hint and capture contract - passed with no skips.

The final unrestricted `npm test` run, with this record in place, completed 2,414 tests:
2,412 passed, one failed and one skipped, in 520 seconds. The failure is
`packages/hook-runner/test/native-attempt-doctor.test.mjs`, one of the three tests known to be
load-sensitive; run alone it passed three times out of three, and it passed in the full run
before this record was written. The skip is the existing absent-Gemini uninstall case,
because Gemini is installed on this machine. The recorded-candidate gate passed.

## Live delivery capture

On 2026-09-21 a private candidate built from this branch (SHA-256
`fa1dab632b9ec5cef0e391b3779816eb479beaaee6c6197b0b166a24b0cf2887`, the same source with
the native contract switched on) was installed into an isolated ACC data home, and a real
Antigravity CLI 1.2.7 TUI was driven under a private PTY on macOS arm64. The agent ran the
relay command named in ACC's one-time context line; the operator approved it once at the
client's permission prompt. All five branches passed and are recorded in
`fixtures/delivery/antigravity-cli-1.2.7-relay-product.json` with its product evidence:

- idle: a question woke the idle session with no user input;
- busy: a question accepted while the model streamed a 5,288-word answer was held 25 seconds
  and presented after that answer completed;
- reply: the agent's `acc reply` reached the sender and acknowledged the question;
- duplicate: one logical message sent twice kept its id and was pushed once;
- fallback: the relay retired itself about five seconds after the client exited, and the
  next message stayed queued.

The run also showed a push landing at the next model invocation when the turn was waiting on
a tool permission, and that the first TUI session in a folder trusted at that launch gives
every hook an empty `workspacePaths`. Both are limitations in the certification and in
`COMPATIBILITY.md`; the second has its own fixture.

## Regression evidence

The relay startup test runs the hook runner's per-turn re-handshake twice against a live
relay. Giving the adapter a `retireNativeSession` that removes the relay's registration -
what the first design specified - made it fail; the shipped adapter has none, and it passes.

Every test that spawns a relay launcher sets its own `ACC_DATA_HOME`: without one, the
launcher found the managed runtime installed on this machine and ran that generation
instead of the checkout.

## Limits

Live delivery is certified for Antigravity CLI 1.2.7 on darwin-arm64 in the TUI only. It is
experimental, off until `acc install --adapter antigravity --delivery actionable|all`, and
runs only after the user approves the relay command in the client. Print mode, the first
session in a newly trusted folder, other versions and other platforms keep next-turn and
inbox delivery. `delivery.replyRoute` stays false. The capture ran against the candidate
above, not against this exact archive. The archive adds what the capture produced - the
certification row, the declared contract and its tests - plus a doctor line for the newly
trusted folder case and documentation; the relay and hook code are unchanged from the candidate.
