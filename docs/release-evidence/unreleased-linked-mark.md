# Development artifact: the linked ACC mark

Captured on October 25, 2026 with Node 26.5.1 on macOS. This is an unpublished
development artifact, built from `f705f76f8a6782825d12be22971e18f44fee1321`.
The package version remains `0.11.1`; existing release records are unchanged.

| Artifact | Value |
|---|---|
| Filename | `agents-can-communicate-0.11.1.tgz` |
| Packed size | 611,721 bytes |
| Files | 378 |
| sha256 | `754a5dfedefb9a3296902520f3bfee74f97e4d571f65334c70ae7bb79a8ebdbf` |

`npm pack --json` created the archive. `node scripts/verify-package.mjs` verified
that exact archive and reported PASS, including installed entry points, runtime
enrollment, and install/uninstall restoration. No package was published. The two
new files are `adapter-codex/plugin/assets/logo.svg` and `composer-icon.svg`.

## What Codex reports for the installed plugin

The archive was installed with `npm install` into a temporary prefix. Then
`acc install --adapter codex` ran with its own `HOME`, `CODEX_HOME` and
`ACC_DATA_HOME`, so no real client home was touched. The real `codex app-server`
from Codex CLI 0.164.0 answered `plugin/list` for that home:

| Field | Reported for `agents-can-communicate@acc-local` |
|---|---|
| `installed`, `enabled` | `true`, `true` |
| `interface.brandColor` | `#3158C3` |
| `interface.logo` | `<home>/.agents/acc-local/plugins/agents-can-communicate/assets/logo.svg` |
| `interface.composerIcon` | `<home>/.agents/acc-local/plugins/agents-can-communicate/assets/composer-icon.svg` |

Both reported paths existed. Their sha256 values matched the files in the source
tree: `24f507aa…ec86813` for the logo and `e7d17ed7…5c39b8a0` for the composer icon.
Before this change the plugin declared none of the three fields. This records
what the client reports. It does not record how a particular Codex surface draws
the icon.

## Tests

- `the installed plugin carries the mark Codex shows for it` in
  `packages/adapter-codex/test/install.test.mjs` failed before the change, when the
  manifest declared no icon fields. It also failed in two mutations:
  - the logo path pointed at a missing `.png`;
  - one coordinate of the composer icon changed.
- `the README opens with the mark the website serves` in
  `tests/docs/readme-mark.test.mjs` failed when the README linked the favicon
  instead of `https://getacc.dev/assets/acc-mark.svg`.
