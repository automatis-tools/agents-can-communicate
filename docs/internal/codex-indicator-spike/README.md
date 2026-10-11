# Codex indicator feasibility experiment

This is an isolated, disposable prototype, not shipped Codex indicator support.
No normal Codex/ACC installation, account, daemon, or user configuration was replaced.

## Native CLI result

Source: official `openai/codex` tag `rust-v0.162.1`, commit
`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`. The patch is restricted to the TUI.
It adds the experimental `CODEX_STATUS_PROVIDER` environment setting: a JSON argv
array, with no shell. The provider reads `{thread_id,cwd}` from stdin and returns
`{spans:[{text,foreground?:[r,g,b],bold?:bool}]}`. It runs asynchronously once per
second with a 500 ms timeout and bounded output. Cached spans lead the existing
footer; stale thread/request/widget results are discarded. Explicit foreground
colors bypass theme softening, and no background is added.

An initial native run exposed an invisible badge after a long path/thread ID.
Leading with the external spans corrected it; a 20-column native truncation test
now covers this behavior.

The final native run used `codex-tui --no-daemon --no-alt-screen`, an isolated home,
an empty trusted test directory, a credential-free local provider configuration,
and external network denial. A real displayed thread UUID was captured by the
provider. Normal ACC SDK/store APIs then created disposable UI fixture state for
that UUID; no ACC JSON records were written by hand. The actual installed ACC
reader observed those records. Native output changed from `ACC ●` to
`ACC ! · turn · acc doctor` and back to `ACC ●` without terminal input or model turns.

[Native proof](native-proof.json): 135 provider calls, median interval 1002 ms,
zero model turns and user/assistant messages, glyph RGB 44,122,57, bold, default
background, native model retained. The browser [preview](cli-preview.jpeg) renders
captured ANSI terminal frames; it is not a desktop-panel screenshot.

Nine focused `external_status_provider` Rust tests passed. A one-channel RGB
mutation made the exact-color test fail; restoring it returned all tests to green.
The full Codex test suite was not run. This proves the UI/read-only integration,
not Codex native message delivery or production readiness.

## Reproduction inputs

- [Codex TUI patch](codex-tui.patch), including the focused tests.
- [Provider example](provider-example.mjs), with `ACC_INDICATOR_ENTRY` selecting the
  installed stable `acc-indicator.mjs`. Launch the provider with the same Node24
  interpreter used to install ACC. `ACC_DATA_HOME` can select an isolated fixture.
- Rust1.95.0; `cargo test --locked --profile dev-small -p codex-tui --lib
  external_status_provider -- --test-threads=1`; `cargo build --locked --profile
  dev-small -p codex-tui --bin codex-tui`.
- The official release manifest says 0.162.1 while its lockfile records local
  packages as 0.0.0. In the isolated checkout, `cargo update --offline --workspace`
  normalized 161 local versions after dependencies were resolved. A TOML comparison
  verified every external dependency source/checksum stayed identical.
- Tested macOS arm64 binary SHA-256:
  `217596f267df8f146587ba06a97dcc9c2e8c29eff2278946c67dd38734d5f59f`.
  The binary is retained locally, not committed or distributed in the npm package.

The patch does not add a supported config key, picker integration, plugin
registration, remote-host semantics or a process-tree supervisor. Direct provider
children are killed on timeout/drop; arbitrary descendant cleanup is not certified.
A missing/invalid generic provider result removes its old segment. The ACC wrapper
maps reader errors to an actionable `ACC !` line. Explicitly disabling all footer
colors/fields is not a production policy this spike settles.

## MCP panel result

The stock Codex0.162.1 app-server accepted the MCP App resource and thread entrypoint.
Direct app-only calls delivered authoritative thread metadata and did not start a
model turn. A forged thread ID was overwritten; primitive metadata was rejected;
missing identity failed before any ACC read. The actual installed reader returned
`problem/not_registered` for the isolated unregistered session and wrote no files.
Local plugin add/remove worked in a disposable home, with configuration restored.

The [panel server](panel-example/server.mjs), [UI](panel-example/panel.html),
[manifest](panel-example/plugin.json), and [launch template](panel-example/mcp.example.json)
are retained as a disposable example. The template uses explicit placeholders;
it is not an installed configuration. The native capture restriction remains.

Evidence: [protocol](panel-latest-proof.json), [identity mutation](panel-mutation-proof.json),
[isolated installation](panel-install-proof.json), [native UI limit](panel-native-check.json).

Native desktop rendering remains unverified. Computer Use rejected
`cua.getApp('com.openai.codex')` with: “Computer Use is not allowed to use the app
'com.openai.codex' for safety reasons.” No alternate UI-control path was used,
no production plugin was registered, and no desktop app was restarted.
The protocol result must not be presented as a successful native panel capture.
