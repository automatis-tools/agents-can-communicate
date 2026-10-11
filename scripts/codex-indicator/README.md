# Local Codex CLI with the ACC indicator

This is an opt-in local build for testing on macOS arm64. It is separate from the
published ACC installer. Stock Codex 0.162.1 has no external status-line command.
The source patch adds that surface to the full CLI, preserving its normal commands,
thread resume, configuration, and native footer items. It does not modify the Codex
desktop application or claim desktop panel support.

The badge leads the footer and refreshes once per second without a model turn.
Only the glyph has color: green `#2c7a39` or warning `#966c1e`, bold, no background.
Failures show `ACC ! · acc doctor`; a known reception fallback adds `turn` or `inbox`.
An empty configured status line hides the badge. `status_line_use_colors = false`
and nonempty `NO_COLOR` suppress its foreground colors.

## Build

Use the official `openai/codex` source at commit
`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` (`rust-v0.162.1`), Rust 1.95.0,
and apply `codex.patch` from this directory. The patch adds TUI code/tests and delegates the parsed update command to the original vendor CLI.
Upstream Codex code is licensed under Apache-2.0; see the upstream LICENSE and NOTICE.

The release manifest says 0.162.1 while local packages in Cargo.lock say 0.0.0.
Normalize those local entries with `cargo update --offline --workspace` after fetching
its pinned dependencies. Verify that no external dependency source or checksum changed.
Then run from `codex-rs`:

```sh
RUST_MIN_STACK=16777216 cargo test --locked --profile dev-small -p codex-tui --lib
RUST_MIN_STACK=16777216 cargo test --locked --profile dev-small -p codex-cli --lib --bin codex
cargo build --locked --profile dev-small -p codex-cli --bin codex
```

Run `node scripts/codex-indicator/verify-update.mjs /absolute/path/to/codex` from the ACC checkout to verify vendor-update routing without a real update.

The full CLI binary is `target/dev-small/codex`. This local debug-profile build is
not a vendor release. Future vendor versions need a newly verified patch and build.

## Install and restore

Use Node 24 and the existing stable managed ACC reader. Pass an independently
verified SHA-256 for the exact compiled binary:

```sh
node scripts/codex-indicator/install.mjs install \
  --binary /absolute/path/to/codex --sha256 VERIFIED_SHA256 \
  --command "$HOME/.local/bin/codex" \
  --reader "$HOME/Library/Application Support/acc/runtime/bin/acc-indicator.mjs" \
  --root "$HOME/Library/Application Support/acc/codex-indicator"
```

The existing command must be a symbolic link to the same vendor version. A concurrent vendor upgrade is refused, so this fixed build cannot silently downgrade it. Installation copies the binary and
bridge into its own directory, records the original link, and atomically points the
command at a launcher. It does not change shell profiles, credentials, config,
installed plugins, or a running daemon. Open a new `codex` terminal session to use it.
`codex update` delegates to the original vendor command; a vendor update may restore
the original command link. The custom build is intentionally not auto-updated.

Run the installed `uninstall` command in that directory to restore the exact original
link. Restoration refuses to replace a later user command and preserves changed or
unknown files. A repeated identical install verifies its owned files and keeps the
original rollback target. Uninstall before installing a different local build.

## Provider contract

`CODEX_STATUS_PROVIDER` is a JSON argv array, executed without a shell. The process
receives only `{thread_id,cwd}` and returns bounded structured spans. The launcher
also sets `CODEX_STATUS_PROVIDER_FALLBACK`, using the same span format, so timeout,
spawn failure, or invalid output replaces old success with a recovery action.
The bridge reads the public ACC indicator by exact native thread UUID; it does not
register, send, discover sessions, renew leases, read transcripts, or call a model.

Native requests have a 500 ms deadline, 4 KiB output limit, 16-span limit and 256-byte
text limit. The bridge gives the reader 400 ms and accepts only known health/reception
values. Unix requests own a process group, killed on completion, cancellation or
timeout. Thread/widget/request identity guards reject stale results, including A→B→A.
The Windows process-tree behavior has not been implemented or certified.

## Verification limits

The installed native CLI was captured at idle through the real ACC reader: ready,
failed automatic delivery with a `turn` fallback, then recovery. The exact glyph
RGB, bold/default-background style and absence of dimming were checked in the
terminal cells. Separate installed captures verified `NO_COLOR`, disabled colors,
and an empty status line. These captures use disposable ACC fixture state; they
certify rendering and read-only observation, not a new delivery capability.
See [verification.json](verification.json) and [native-preview.jpeg](native-preview.jpeg).

All 11 focused Node checks, 12 provider Rust checks, and 328 CLI unit tests passed (one CLI test ignored). The full ACC suite
passed with 3274 successes and 8 skips. The public npm artifact is unchanged.
The full upstream TUI suite is **not green**: 5665 passed, 39 failed, 4 ignored.
There are 36 snapshot mismatches against upstream's 0.0.0 fixtures when built as
the release version 0.162.1. A representative snapshot failure and the separate
transcript-paging and pet-image assertions reproduced with unmodified upstream
TUI files. An inline-snapshot loop assertion failed in the broad run and passed
alone on unmodified upstream. No upstream snapshots or assertions were weakened.
This remains a local testing build, not a certified vendor release.
